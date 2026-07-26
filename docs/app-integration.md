# Integrating your app with Iriguchi

This guide walks through everything a new app needs to register itself with the gateway and expose agents. The working reference implementation is [`examples/weather-app`](../examples/weather-app).

## How it fits together

```
your clients ──▶ Iriguchi /v1/chat/completions (iri_agent: "your-bot")
                    │
                    │ 1. resolves your agent (system prompt, tools, skills, provider)
                    │ 2. runs the agent loop on the configured LLM provider
                    │ 3. when the model calls a tool ──▶ your app's HTTP endpoint
                    ▼
                streams an OpenAI-style SSE response back to the client
```

Your app never talks to an LLM. It does three things: serve a manifest, register once at startup, and answer tool calls.

## Step 1 — Serve `GET /agents-manifest`

Expose an endpoint that returns your app's manifest as JSON. The gateway presents `Authorization: Bearer <app_token>`, and this endpoint **must accept any non-empty Bearer token**. It **must not** compare that token against your stored app token:

```ts
app.get("/agents-manifest", (c) => {
  const auth = c.req.header("Authorization");
  // Presence-only, by design — see below. Do not "harden" this into an
  // equality check against your app token; it will break registration.
  if (!auth?.startsWith("Bearer ") || auth.length <= 7) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return c.json(manifest);
});
```

**Why presence-only.** The gateway mints your app token *and then immediately fetches this endpoint with it*, before registration returns (step 2). At that moment your app has never seen the token and cannot compare against it, so an equality check rejects the one fetch that would complete your registration — and because re-registering rotates the token, it breaks on every restart, not just the first. This is safe because the manifest is metadata: agent ids, prompts, tool schemas, and endpoint paths, never user or business data.

Your **tool endpoints** do the opposite — they return real data and are only ever called after registration, so they must check exact equality against the app token (step 3).

### Manifest shape

Validated against a strict schema (`src/registry/schema.ts`); the whole manifest is rejected atomically on any error.

```jsonc
{
  "manifest_version": "1",
  "app": {
    "id": "my-app",              // kebab-case, must equal the id you register with
    "name": "My App",
    "description": "What this app does"
  },
  "agents": [
    {
      "id": "my-bot",            // kebab-case, unique within the manifest
      "name": "My Bot",
      "description": "What this agent does",
      "system_prompt": "You are ...",
      "default_model": "claude-opus-5",     // optional; provider-native model string
      "provider": "anthropic",              // optional; must be configured on the gateway,
                                            // else registration fails with 400 unknown_provider.
                                            // Omit to use the gateway's default provider.
      "tools": [
        {
          "type": "api_call",               // only supported tool type today
          "name": "get_thing",
          "description": "Fetches a thing. The model reads this to decide when to call it.",
          "parameters": {                   // JSON Schema for the tool's input
            "type": "object",
            "properties": { "id": { "type": "string" } },
            "required": ["id"]
          },
          "endpoint": { "method": "POST", "path": "/api/thing" },  // path is relative to your base_url
          "timeout_ms": 10000               // optional; defaults to the gateway's IRI_TOOL_CALL_TIMEOUT_MS
        }
      ],
      "skills": [
        { "name": "my-skill", "content": "# Skill\nInline markdown..." },
        { "name": "remote-skill", "url": "https://example.com/skill.md" }
        // each skill: kebab-case name + exactly ONE of content or url
      ]
    }
  ]
}
```

Notes on models and providers:
- `default_model` is passed through verbatim — write it in the form the agent's provider expects (`claude-opus-5` for Anthropic direct, `moonshotai/kimi-k3` for OpenRouter's Anthropic endpoint, a local id like `ornith-1.0-35b` for LM Studio).
- If you set `provider` but omit `default_model`, the agent inherits that provider's configured default model — always a model the provider actually serves.

## Step 2 — Register at startup

`POST {gateway}/apps/register` with the shared registration secret (the gateway operator's `IRI_REGISTRATION_SECRET`):

```bash
curl {gateway}/apps/register \
  -H "Authorization: Bearer $IRI_REGISTRATION_SECRET" \
  -H "Content-Type: application/json" \
  -d '{ "id": "my-app", "base_url": "http://localhost:5000" }'
```

The gateway then fetches `{base_url}/agents-manifest`, validates it (schema, `app.id` must match your registered `id`, all `provider` references must be configured), stores it, and responds:

```json
{ "app_token": "…43-char token…", "accepted_agents": ["my-bot"] }
```

Note the ordering: the token in that response is the same one the gateway just presented on the manifest fetch. The fetch happens *before* you have the token, which is why step 1 is presence-only.

**Store the `app_token`.** It authenticates both directions:
- the gateway presents it to *you* on every tool call (step 3) — verify it exactly;
- *you* present it to the gateway for `POST /apps/my-app/refresh-manifest` and `DELETE /apps/my-app`.

It is also presented on manifest fetches, but as step 1 explains, that endpoint must not verify it.

Re-registering is an upsert and **rotates the token**, so registering on every startup (with a short retry loop, like the weather app does) is the simplest pattern — the gateway may not be up yet when your app boots.

Failure modes: `401` bad secret · `400` invalid manifest / id mismatch / `unknown_provider` · `502 app_unavailable` if your manifest endpoint couldn't be reached · `502 manifest_unauthorized` if your manifest endpoint returned `401`/`403` — almost always an equality check on the app token, see step 1.

## Step 3 — Answer tool calls

When a model invokes one of your `api_call` tools, the gateway calls `{base_url}{endpoint.path}` with:

- `Authorization: Bearer <app_token>` — verify it.
- **POST/PUT/PATCH**: the model-generated arguments as a JSON body.
- **GET/DELETE**: no body; for GET the arguments are serialized into query params (objects as JSON strings).

Respond with JSON. Contract details:
- Non-2xx responses, timeouts, and network errors are wrapped as `{ "error": ... }` and fed back to the model — return meaningful error bodies and the model can react to them.
- The gateway retries **once** after 500ms on 5xx / timeout / network errors, so tool endpoints should be idempotent or tolerate a duplicate call.

## Step 4 — Keep the manifest fresh

- The gateway re-fetches manifests in the background (every `IRI_MANIFEST_CACHE_TTL_MS`, default 5 min). If a refresh fails — endpoint down, invalid manifest, now-unknown provider — the gateway logs a warning and keeps serving the last good manifest (stale-on-error).
- To force an immediate update after you change agents: `POST {gateway}/apps/my-app/refresh-manifest` with `Authorization: Bearer <app_token>`.
- To deregister (cascades to your agents): `DELETE {gateway}/apps/my-app` with the same token.

## Step 5 — Use your agent

Any OpenAI-compatible client can now target your agent by adding `iri_agent` to a standard chat completion request:

```bash
curl {gateway}/v1/chat/completions \
  -H "Authorization: Bearer $IRI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "iri_agent": "my-bot",
    "messages": [{ "role": "user", "content": "Get me thing 42" }],
    "stream": true
  }'
```

Omit `model` to use the agent's `default_model` (or its provider's default). The gateway is stateless — send full conversation history on every request, standard OpenAI semantics.

### Streaming vs non-streaming

`stream` selects the response shape, per the OpenAI protocol:

- **`stream: true`** → `text/event-stream` of `chat.completion.chunk` events, terminated by `data: [DONE]`.
- **`stream: false`, or `stream` omitted** → a single `application/json` `chat.completion` object.

So a plain client needs no SSE handling at all:

```bash
curl {gateway}/v1/chat/completions \
  -H "Authorization: Bearer $IRI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "iri_agent": "my-bot",
    "stream": false,
    "messages": [{ "role": "user", "content": "Get me thing 42" }]
  }'
```

```json
{
  "id": "chatcmpl-01J…",
  "object": "chat.completion",
  "created": 1717200000,
  "model": "claude-sonnet-4-6",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "Thing 42 is…" },
      "finish_reason": "stop"
    }
  ]
}
```

The non-streaming body is the streaming run's text deltas concatenated, so both modes return the same content for the same run. `finish_reason` is `"stop"`, or `"length"` when the agent hit `IRI_MAX_AGENT_TURNS`. Add `?iri_show_tool_calls=true` and the agent's tool invocations appear as `choices[0].message.tool_calls`. A non-boolean `stream` is a `400`.

Non-streaming buffers the whole run before responding, so nothing arrives until the agent finishes — set a client timeout accordingly, and prefer `stream: true` for interactive UIs.
