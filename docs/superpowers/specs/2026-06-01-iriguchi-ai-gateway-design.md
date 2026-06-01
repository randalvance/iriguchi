# Iriguchi — AI Gateway Design

**Status:** Draft v1
**Date:** 2026-06-01
**Owner:** Randal

## Summary

Iriguchi (Japanese: "entrance / gateway") is a Bun/Hono service that exposes an OpenAI-compatible chat API and runs Claude Agent SDK-powered agents on behalf of other applications. Apps register themselves with the gateway and expose a `/agents-manifest` endpoint describing their agents — system prompts, default models, tools, and skills. The gateway becomes the single AI brain so other apps don't have to embed agent logic.

The gateway is OpenAI-compatible enough that generic clients (OpenWebUI, OpenCode, Hermes) can connect to it as a vanilla LLM. App-aware mode is opt-in via a single non-standard field (`iri_agent`) in the request body, which selects the agent, manifest, tools, and skills.

For v1, the gateway uses an Anthropic subscription account with `claude-sonnet-4-6` as the default model. Local LLM support (Ollama, LM Studio) is reachable later by setting `ANTHROPIC_BASE_URL` — both runtimes now natively expose the Anthropic `/v1/messages` API, so no SDK swap is required.

## Goals

- Single OpenAI-compatible endpoint (`/v1/chat/completions`) that works with generic clients out of the box.
- App-aware mode: `iri_agent=<id>` resolves to a per-app agent with its own system prompt, tools, and skills.
- Dynamic app registration: apps register on startup; the gateway fetches their `/agents-manifest`.
- Tool execution: `api_call` tools forward LLM-generated parameters to the owning app's HTTP endpoint.
- Skills: app-shipped Claude-Code-style skill markdown loaded via the SDK's native skills mechanism.
- Demo app proving the full registration → manifest → chat → tool-call → response flow.

## Non-goals (v1)

- Agent-to-agent calling. Deferred to v2.
- Stateful conversation storage. Stateless OpenAI semantics only; clients pass history.
- Multi-process deployment, horizontal scaling, Redis. Single Bun process.
- Rate limiting, per-client quotas. Reverse-proxy concern.
- Embeddings endpoint, fine-tuning, image generation.
- Streaming reconnection / resumable streams.

## Architecture

Single Bun process running a Hono HTTP server. Each chat request resolves an agent, materializes its skills to a per-agent tempdir, builds an in-process MCP tool server that translates the agent's `api_call` tools into HTTP calls back to the owning app, then invokes the Claude Agent SDK's `query()` in-process. The SDK's streamed output is translated to OpenAI SSE chunks and streamed to the client.

Registered apps and their cached manifests live in a local SQLite file (via `bun:sqlite`). Manifest cache TTL is 5 minutes; a background timer refreshes stale entries.

### Repo layout

```
iriguchi/
├── src/
│   ├── server.ts              # Hono app, routes, startup
│   ├── routes/
│   │   ├── openai.ts          # /v1/chat/completions, /v1/models
│   │   └── registration.ts    # /apps/register, /apps/:id/refresh-manifest, DELETE /apps/:id
│   ├── agent/
│   │   ├── runner.ts          # Wraps Claude Agent SDK query() per request
│   │   ├── tools.ts           # MCP tool server: api_call → HTTP
│   │   ├── skills.ts          # Materialize skills from manifest → tempdir
│   │   └── openai-sse.ts      # Translate SDK stream → OpenAI SSE chunks
│   ├── registry/
│   │   ├── store.ts           # SQLite-backed app + manifest store
│   │   ├── manifest.ts        # Fetch + validate /agents-manifest, background refresh
│   │   └── schema.ts          # Zod schemas for manifest, agent, tool
│   ├── auth.ts                # Bearer token middleware
│   └── config.ts              # Env var loading
├── examples/
│   └── weather-app/
│       ├── src/server.ts      # Hono app: /agents-manifest, /api/forecast, /
│       └── public/index.html  # Static chat UI
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/                   # Gated by IRI_E2E=1
├── package.json
├── bunfig.toml
└── README.md
```

**File size discipline:** keep each source file under ~200 LOC where reasonable. Split if growth is organic.

## Manifest schema (the core data model)

Apps expose `GET /agents-manifest` returning the following Zod-validated structure:

```typescript
{
  manifest_version: "1",
  app: {
    id: "weather-app",                  // matches registration id
    name: "Weather App",
    description: "Provides weather forecasts and alerts"
  },
  agents: [
    {
      id: "weather-bot",                // globally unique across all apps
      name: "Weather Bot",
      description: "Answers questions about weather",
      system_prompt: "You are a helpful weather assistant...",
      default_model: "claude-sonnet-4-6",   // optional; gateway fallback applies
      tools: [
        {
          type: "api_call",
          name: "get_forecast",
          description: "Get the weather forecast for a location",
          parameters: {                  // JSON Schema, passed verbatim to LLM
            type: "object",
            properties: {
              location: { type: "string", description: "City name or ZIP" },
              days:     { type: "integer", minimum: 1, maximum: 7, default: 3 }
            },
            required: ["location"]
          },
          endpoint: {
            method: "POST",
            path: "/api/forecast"        // relative to registered base_url
          },
          timeout_ms: 30000              // optional; default 30000
        }
      ],
      skills: [
        {
          name: "weather-jargon",
          content: "---\nname: weather-jargon\ndescription: ...\n---\n\n# ..."
        }
        // OR url-based: { name: "weather-jargon", url: "https://app/skills/weather-jargon.md" }
      ]
    }
  ]
}
```

### Key schema decisions

- **JSON Schema for tool parameters** — forwarded as-is to the SDK's tool definition. Validated at call time against the LLM-provided arguments.
- **One tool type for v1: `api_call`.** The `type` discriminator lets us add `mcp_server`, `python_eval`, etc. later without bumping manifest version.
- **Tool endpoints are relative to the app's registered `base_url`** — no external URLs (closes a security surface).
- **Skills carry their content inline or by URL.** Gateway materializes them to `<tmp>/iri/agents/<agent_id>/.claude/skills/<skill-name>/SKILL.md` before invoking the SDK with `cwd: <tmp>/iri/agents/<agent_id>` and `skills: 'all'`.
- **Default model fallback:** request `model` → agent's `default_model` → gateway env `IRI_DEFAULT_MODEL` (= `claude-sonnet-4-6` for v1).
- **Generic agent:** if no `iri_agent` is passed, the gateway runs a built-in "generic" agent (baseline system prompt, no tools, no skills). This is how vanilla OpenWebUI/OpenCode/Hermes connect.

### SQLite schema

```sql
CREATE TABLE apps (
  id                   TEXT PRIMARY KEY,
  base_url             TEXT NOT NULL,
  app_token            TEXT NOT NULL,         -- gateway → app bearer
  registered_at        INTEGER NOT NULL,
  manifest_json        TEXT,
  manifest_fetched_at  INTEGER
);

CREATE TABLE agents (
  id      TEXT PRIMARY KEY,                   -- globally unique
  app_id  TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE
);
CREATE INDEX agents_app_idx ON agents(app_id);
```

`agents` is a denormalized lookup table populated from the manifest on every (re)fetch — gives O(1) `agent_id → app` lookup per chat request.

## API surface

All endpoints versioned under `/v1`. Authentication is bearer-token throughout.

### `POST /v1/chat/completions`

OpenAI-compatible chat endpoint. Standard fields (`model`, `messages`, `stream`, `temperature`, `top_p`, `max_tokens`, `stop`, `seed`) work as expected.

**Custom field:** `iri_agent` (string, optional) — globally unique agent id. If omitted, runs the generic agent.

**Custom query param:** `iri_show_tool_calls=true` (optional) — emits tool_use events to the client as `delta.tool_calls` chunks. Default off; tool use is invisible to clients.

**Streaming:** SSE, OpenAI-compatible chunk shape. `[DONE]` sentinel terminates.

**Auth:** `Authorization: Bearer <IRI_API_KEY>`.

### `GET /v1/models`

OpenAI-compatible. Returns the set of allowed model ids the gateway accepts (anchored on `claude-sonnet-4-6` plus configurable additions).

### `POST /apps/register`

App registration. Body:
```json
{ "id": "<app-id>", "base_url": "http://localhost:4001" }
```
Gateway generates a random `app_token`, calls `GET <base_url>/agents-manifest` with it, validates the manifest, persists, and returns `{ "app_token": "...", "accepted_agents": [...] }`.

**Auth:** `Authorization: Bearer <IRI_REGISTRATION_SECRET>`.

### `POST /apps/:id/refresh-manifest`

Force-refresh an app's manifest. **Auth:** `Authorization: Bearer <app_token>`.

### `DELETE /apps/:id`

Deregister an app, cascade-deletes its agents. **Auth:** `Authorization: Bearer <app_token>`.

## Data flows

### Registration (one-time, app startup)

1. App boots, reads `IRI_GATEWAY_URL` and `IRI_REGISTRATION_SECRET` from env.
2. App POSTs `/apps/register` with its `id` and `base_url`.
3. Gateway generates `app_token`, GETs `<base_url>/agents-manifest` with `Authorization: Bearer <app_token>`.
4. App responds with manifest. Gateway validates (Zod), upserts `apps` row, replaces `agents` rows.
5. Gateway returns `201 { app_token, accepted_agents }`. App stores `app_token` for later refresh/deregister calls.

### Chat — generic agent (no `iri_agent`)

OpenWebUI / OpenCode / Hermes path. Request → SDK with baseline system prompt → SDK streams → SSE translator → client. No manifest, no skills, no tools.

### Chat — app-owned agent (with `iri_agent`)

1. Validate bearer token.
2. Look up `iri_agent` → `app_id` → cached manifest.
3. Materialize the agent's skills to `<tmp>/iri/agents/<agent_id>/.claude/skills/<name>/SKILL.md` (cached across requests; invalidated on manifest change).
4. Build in-process MCP tool server registering each `api_call` tool. Each tool handler POSTs to `<app.base_url><tool.endpoint.path>` with `Authorization: Bearer <app_token>` and the LLM-provided params as JSON body.
5. Invoke `query({ model, systemPrompt, cwd, skills: 'all', mcpServers, messages, stream: true })`.
6. SSE translator (`openai-sse.ts`) maps SDK events to OpenAI chunks; tool use stays invisible unless `iri_show_tool_calls=true`.
7. Stream until SDK emits `done`; send `data: [DONE]`.

### Manifest refresh (background)

Bun `setInterval` every 30s walks the `apps` table, refetches any manifest older than `IRI_MANIFEST_CACHE_TTL_MS` (default 5 min). On fetch failure, log and serve the last good manifest (stale-on-error).

## Auth model

Three trust boundaries, all bearer-token:

| Direction | Header | Token source |
|---|---|---|
| Client → Gateway | `Authorization: Bearer <IRI_API_KEY>` | Env var on gateway, shared with clients |
| App → Gateway (register) | `Authorization: Bearer <IRI_REGISTRATION_SECRET>` | Env var on gateway, shared with apps |
| Gateway → App (manifest fetch, tool calls) | `Authorization: Bearer <app_token>` | Generated on registration, returned to app |
| App → Gateway (refresh, deregister) | `Authorization: Bearer <app_token>` | Same `app_token` as above |

All tokens are random 32-byte values, base64url-encoded. Constant-time comparison on the gateway side.

## Error handling

All client-facing errors use OpenAI's error shape:
```json
{ "error": { "type": "...", "message": "...", "code": "..." } }
```

| Situation | HTTP | Type | Notes |
|---|---|---|---|
| Missing/invalid auth | 401 | `invalid_request_error` | |
| `iri_agent` unknown | 404 | `invalid_request_error` | Message lists known agent ids |
| Manifest fetch fails on register | 502 | `app_unavailable` | Registration rejected; nothing persisted |
| Manifest cache stale + refresh fails | 200 (stream) | warning as `system` delta; agent runs with stale manifest | Stale-on-error |
| `api_call` tool returns 4xx | tool_result | `{ "error": "...", "status": 4xx }` to LLM | LLM decides next action |
| `api_call` tool returns 5xx / times out | tool_result | one 500ms retry, then error to LLM | Single retry only in v1 |
| Anthropic API error | 502 | `upstream_error` | Pass through message |
| Skill materialization fails | 500 | `internal_error` | Log + bail; don't run without the skill |
| LLM calls unknown tool | tool_result | error to LLM ("unknown tool: X") | SDK self-recovers |

### Hard limits (configurable via env)

- `IRI_MAX_AGENT_TURNS=20` — agent loop iteration cap.
- `IRI_TOOL_CALL_TIMEOUT_MS=30000` — default per-tool HTTP timeout (manifest can override per-tool).
- `IRI_MANIFEST_CACHE_TTL_MS=300000` — 5 minutes.
- `IRI_REQUEST_TIMEOUT_MS=300000` — 5 minutes per chat request.

## Observability

- Structured JSON logs to stdout. No external logging lib in v1.
- Every chat request gets a ULID `request_id`; included in every log line for that request and returned as `X-Request-Id` response header.
- Log events: `request.start`, `manifest.fetch`, `tool.call.start`, `tool.call.complete`, `tool.call.error`, `agent.turn`, `request.complete` (with duration).
- No metrics/tracing in v1.

## Local LLM compatibility

The Claude Agent SDK accepts `ANTHROPIC_BASE_URL` for override. As of 2026, both Ollama (≥ 0.14.0) and LM Studio (≥ 0.4.1) natively expose the Anthropic `/v1/messages` API. Switching the gateway to a local model is a deployment-time change: set `ANTHROPIC_BASE_URL=http://localhost:11434` (Ollama) or equivalent. No code change required.

If a future deployment needs to bridge to OpenAI-only backends, `claude-code-router` and `LiteLLM` proxy are tested community options.

## Demo app: `examples/weather-app/`

A separate Bun/Hono server on port 4001 that:

1. On startup, POSTs `/apps/register` to the gateway with its base URL.
2. Exposes `GET /agents-manifest` returning a single `weather-bot` agent with one `api_call` tool (`get_forecast`) and one inline skill (`weather-jargon`).
3. Exposes `POST /api/forecast` accepting `{ location, days }` and returning fake forecast JSON.
4. Serves `GET /` with a static HTML chat page that calls `POST <gateway>/v1/chat/completions` with `iri_agent: "weather-bot"`.

Proves the full registration → manifest → chat → tool call → response loop end-to-end.

## Testing strategy

Three layers, all via `bun test`.

**Unit:** Zod schema validation, SSE translator (pure-function table tests), tool parameter coercion, skill materializer.

**Integration:** SQLite registry round-trips, chat-flow with the Anthropic API mocked at the HTTP layer (do **not** mock the SDK itself — mock its underlying transport), tool-call end-to-end with a mock app endpoint.

**E2E:** Gated by `IRI_E2E=1`. Spins up gateway + weather-app on real ports, calls `/v1/chat/completions` against real Claude Sonnet using a `.env.test` API key. One assertion: real response received. Manual-trigger CI job only.

**TDD discipline:** every implementation task writes the failing test first, especially for the SSE translator and manifest schema (both crisp pure functions).

**Skipped in v1:** performance tests, fuzz tests, snapshot tests of LLM output (non-deterministic — assert on structure, not text), cross-platform tests (Bun on macOS/Linux only).

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | required | Anthropic subscription account key |
| `ANTHROPIC_BASE_URL` | (unset) | Override for local LLM (Ollama, LM Studio) |
| `IRI_DEFAULT_MODEL` | `claude-sonnet-4-6` | Fallback model when neither request nor agent specifies |
| `IRI_API_KEY` | required | Bearer for client → gateway |
| `IRI_REGISTRATION_SECRET` | required | Bearer for app → gateway register |
| `IRI_MAX_AGENT_TURNS` | `20` | Agent loop iteration cap |
| `IRI_TOOL_CALL_TIMEOUT_MS` | `30000` | Default per-tool HTTP timeout |
| `IRI_MANIFEST_CACHE_TTL_MS` | `300000` | Manifest cache TTL |
| `IRI_REQUEST_TIMEOUT_MS` | `300000` | Chat request total timeout |
| `IRI_DB_PATH` | `./iriguchi.db` | SQLite file path |
| `IRI_PORT` | `4000` | Gateway HTTP port |

## Open questions

None blocking. Decisions noted above are final for v1.

## Out-of-scope, deferred items

- Agent-to-agent calling (`can_call_agents` field reserved in manifest schema but ignored in v1).
- Multiple tool types beyond `api_call`.
- Stateful sessions.
- External-URL tools (cross-app or 3rd-party APIs).
- Horizontal scaling, multi-process deployment.
- Per-client rate limiting.
- Reconnectable streams.
