# Iriguchi

Iriguchi (Japanese: "entrance / gateway") is an AI gateway: a single OpenAI-compatible chat endpoint that runs Claude Agent SDK-powered agents on behalf of other applications. Apps register themselves with the gateway and expose a `/agents-manifest` endpoint describing their agents, tools, and skills. Other apps don't need to embed agent logic — they just call this gateway.

- **Stack:** Node (≥ 24), Hono, Zod, `@anthropic-ai/claude-agent-sdk`, `node:sqlite`. TypeScript runs directly — no build step.
- **OpenAI compat:** Vanilla `/v1/chat/completions` works with OpenWebUI, OpenCode, and other OpenAI-compatible clients. App-aware mode is opt-in via the `iri_agent` field.
- **Multi-provider:** Named Anthropic-shaped backends configured side by side — Anthropic direct, OpenRouter's Anthropic endpoint, or local Ollama (≥ 0.14.0) / LM Studio (≥ 0.4.1), both of which expose the Anthropic `/v1/messages` API natively. Agents pick their provider in their manifest.

## Quickstart

0. Install [Node.js](https://nodejs.org) 24 or newer if you don't have it (or use the repo's devcontainer). Node runs the TypeScript sources directly, and `node:sqlite` needs that version.
1. Copy `.env.example` to `.env` and fill in `IRI_API_KEY`, `IRI_REGISTRATION_SECRET`, and at least one provider triple (`IRI_PROVIDER_<NAME>_API_KEY` / `_BASE_URL` / `_DEFAULT_MODEL`). For a local LM Studio provider, start LM Studio's server (default port 1234) and use the model id it reports at `/v1/models`.
2. Start the gateway:
   ```bash
   npm install
   npm run dev
   ```
   It listens on `IRI_PORT` (default 4000).
3. Verify it's up:
   ```bash
   curl http://localhost:4000/healthz
   curl -H "Authorization: Bearer $IRI_API_KEY" http://localhost:4000/v1/models
   ```
4. (Optional) Start the demo weather app in another terminal:
   ```bash
   cd examples/weather-app
   npm install
   IRI_REGISTRATION_SECRET=$(grep IRI_REGISTRATION_SECRET ../../.env | cut -d= -f2) npm run dev
   ```
5. Open <http://localhost:4001> and ask "What's the weather in NYC?"

## Providers

Iriguchi routes each request to a named Anthropic-shaped backend. Configure providers via env vars — all three vars are required per provider:

```bash
IRI_PROVIDER_ANTHROPIC_API_KEY=sk-ant-...
IRI_PROVIDER_ANTHROPIC_BASE_URL=https://api.anthropic.com
IRI_PROVIDER_ANTHROPIC_DEFAULT_MODEL=claude-opus-5

IRI_PROVIDER_OPENROUTER_API_KEY=sk-or-...
IRI_PROVIDER_OPENROUTER_BASE_URL=https://openrouter.ai/api
IRI_PROVIDER_OPENROUTER_DEFAULT_MODEL=moonshotai/kimi-k3
IRI_PROVIDER_OPENROUTER_AUTH_STYLE=auth_token

IRI_DEFAULT_PROVIDER=anthropic
```

Only providers speaking the Anthropic `/v1/messages` API are supported today (Anthropic direct, OpenRouter's Anthropic endpoint, LM Studio ≥ 0.4.1, Ollama ≥ 0.14.0, Bedrock/Vertex Claude, or any Anthropic-compat proxy) — but any model behind such an endpoint works, not just Claude. Non-Anthropic-shaped providers (raw OpenAI shape) are out of scope for v1.

### Credential style

`IRI_PROVIDER_<NAME>_AUTH_STYLE` is optional and defaults to `api_key`, which sends the credential as `ANTHROPIC_API_KEY`. Anthropic-compatible gateways that authenticate by bearer token need `auth_token`, which sends it as `ANTHROPIC_AUTH_TOKEN` **and** sets `ANTHROPIC_API_KEY` to an empty string.

The empty value is deliberate and must not be "cleaned up". If `ANTHROPIC_API_KEY` is absent rather than empty, the runtime falls back to authenticating against Anthropic directly — the request succeeds against the wrong endpoint on the wrong account, which is far harder to notice than a failure.

### OpenRouter

OpenRouter serves an Anthropic-compatible surface, so no translation layer is involved. Two details cost time if you get them wrong:

- The base URL is the bare `https://openrouter.ai/api` root; the client appends `/v1/messages`.
- Model names are OpenRouter slugs. It is `moonshotai/kimi-k3` — `moonshot/kimi-k3` is a 404, and it is the most common first-call mistake.

OpenRouter is **billed per token**, unlike a local LM Studio or Ollama provider. Keep a local provider as `IRI_DEFAULT_PROVIDER` and let individual agents opt in via `provider` in their manifest: per-agent selection is the cost boundary, since vanilla requests and every agent that omits `provider` go to the default.

Agents opt into a non-default provider in their manifest:

```json
{
  "agents": [
    {
      "id": "weather-bot",
      "provider": "openrouter",
      "default_model": "moonshotai/kimi-k3",
      ...
    }
  ]
}
```

Model names are pass-through: write the string your provider expects. An agent that omits `default_model` inherits its routed provider's `DEFAULT_MODEL`. Registration rejects manifests that reference unconfigured providers. `/v1/models` advertises the default provider's default model.

## Generic OpenAI client usage

```bash
curl http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer $IRI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

`stream` selects the response shape, per the OpenAI protocol: `stream: true` returns an SSE stream of `chat.completion.chunk` events ending in `data: [DONE]`; `stream: false` — **or an omitted `stream`** — returns a single `chat.completion` JSON object. A non-boolean `stream` is a `400`.

> **Breaking (unreleased):** the gateway previously streamed regardless of `stream`. Clients that omitted `stream` and read SSE must now send `stream: true` explicitly.

See [streaming vs non-streaming](docs/app-integration.md#streaming-vs-non-streaming) for the non-streaming response shape.

## App-aware usage

To register your own app and expose agents (manifest shape, registration flow, tool-call contract), see the **[app integration guide](docs/app-integration.md)**.

```bash
curl http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer $IRI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "iri_agent": "weather-bot",
    "messages": [{"role": "user", "content": "Forecast for Tokyo"}],
    "stream": true
  }'
```

## Page-aware clients

A client can tell the gateway what its user is looking at, so an agent can resolve "this account" or "these rows" without the user restating them. Send any JSON object as `iri_context`:

```bash
curl http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer $IRI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "iri_agent": "finance-bot",
    "messages": [{"role": "user", "content": "what was the total spending of this account last month"}],
    "iri_context": {
      "route": "/accounts/acc_42",
      "account_id": "acc_42",
      "today": "2026-08-09"
    }
  }'
```

No schema to declare and no registration step — the gateway checks only that it is a JSON object within `IRI_MAX_CONTEXT_BYTES` (default 65536), and rejects otherwise with `400 invalid_context` or `400 context_too_large`. Context is request-scoped: nothing is stored between requests.

Top-level scalars go into the agent's system prompt; nested objects and arrays appear as placeholders and are read on demand through a gateway-owned `get_context` tool, so a large payload costs tokens only on the turn that reads it. Manifest tools can also carry a `when` clause and be exposed only on matching screens. Both are covered in [making your agent page-aware](docs/app-integration.md#step-6--make-your-agent-page-aware).

Context is client-supplied and reaches the model — treat it as untrusted data, and don't put secrets in it. Values are never logged; the gateway records only key names and byte size.

## MCP servers

An agent can reach tools served by an external [MCP](https://modelcontextprotocol.io) server, not only the `api_call` endpoints its own app exposes. Note the direction: `api_call` tools are ones an app pushes at the gateway for the gateway to call back into, while an MCP server is one the gateway dials *out* to and discovers tools from.

Declare a server in the agent's `tools` array with `type: "mcp"`:

```json
{
  "type": "mcp",
  "name": "finance",
  "url": "http://finance-mcp.finance-app.svc.cluster.local:8080/mcp",
  "headers": { "X-Example": "value" },
  "tools": ["list_accounts", "get_transaction"],
  "timeout_ms": 30000
}
```

| Field | Required | Default | Notes |
|---|---|---|---|
| `name` | yes | — | Kebab-case. Becomes the tool prefix, so it cannot contain `_`. |
| `url` | yes | — | Absolute `http`/`https` URL of the streamable-HTTP endpoint. |
| `headers` | no | `{}` | Sent on every request to that server. |
| `tools` | no | all | Allowlist of tool names to expose. `[]` parks the server without removing it. |
| `timeout_ms` | no | `IRI_TOOL_CALL_TIMEOUT_MS` | Per-call bound. |

**One entry, many tools.** Every other kind of tool declaration describes exactly one tool. An `mcp` entry is a *reference*: its tools are unknown until the gateway connects, and it expands into however many the server advertises. Registration therefore validates the entry's shape but does not connect, so a server that happens to be down does not fail a registration.

**Names are prefixed.** A tool arrives at the model as `<server>__<tool>` — `finance__list_accounts` — which is why server names exclude `_`: the first `__` is unambiguously the separator. Prefixing makes collisions with `api_call` names impossible by construction; a discovered tool whose prefixed name is over 64 characters, contains anything outside `[A-Za-z0-9_-]`, or is already claimed on that agent is dropped with a `warn` rather than failing the run.

**Discovery is lazy.** The gateway connects and calls `tools/list` the first time a run needs a server, never at boot, and caches the result for `IRI_MCP_CACHE_TTL_MS`. Stale entries refresh on the same background tick that refreshes app manifests. Two agents naming the same URL and headers share one connection and one cache entry.

**Failure degrades rather than aborts.** An unreachable server costs its own tools and nothing else — the run continues with whatever else the agent has, and an agent whose only server is down still answers. A server that was reachable once keeps serving its last known tool list until a re-list succeeds. Tool failures reach the model as data in the same result shape `api_call` failures use, so a run is never aborted by one.

### Configuration

```bash
IRI_MCP_CACHE_TTL_MS=300000
IRI_MCP_ALLOWED_ORIGINS=http://finance-mcp.finance-app.svc.cluster.local:8080
```

`IRI_MCP_ALLOWED_ORIGINS` is a comma-separated origin allowlist. It matters because MCP URLs arrive from registering apps, so without it a registration can point the gateway at any host it names. It is enforced at registration *and* again at connect time, so tightening it takes effect against manifests already in the store. Unset or empty means unrestricted.

### Not supported

- **Authentication beyond static `headers`.** No credential store, no OAuth, no token refresh. The `headers` field exists so a server that wants a bearer token can have one, but nothing manages its lifecycle.
- **`listChanged` notifications.** A server may advertise the capability, but a stateless HTTP transport has no channel to deliver one. The TTL is the only invalidation, so a newly added tool is invisible for up to one cache period.
- **Non-HTTP transports.** Streamable HTTP only — no stdio, no local servers.

## Management UI

A first-party client — a chat panel and a read-only agent catalog — served by the gateway at `/ui`. It is a separate Astro package in `ui/`, built to static assets, reading everything over HTTP from a private `/internal/*` surface. See [`ui/DESIGN.md`](ui/DESIGN.md) for its design system.

```bash
npm run ui:install     # once, installs the ui/ package's own dependencies
npm run ui:build       # produces ui/dist
IRI_UI_ENABLED=true npm run dev
```

Then open <http://localhost:4000/ui>.

> **`/internal/*` is unauthenticated.** That is the design, not an oversight: the UI holds no credential, which is why it can never leak one. The consequence is that anyone who can reach the gateway port while `IRI_UI_ENABLED=true` can read your full agent catalog and spend provider tokens through the chat proxy. Enable it only when the port is confined to localhost or a trusted network — never on a published port. It is **off by default**, including in the container image, and turning it on logs a `warn` naming the exposure.

| Variable | Default | Notes |
|---|---|---|
| `IRI_UI_ENABLED` | `false` | Mounts `/ui` and `/internal/*`. Both are absent — plain `404` — when off. |
| `IRI_UI_DIST` | `./ui/dist` | Where the built assets live. A missing build is reported with the command to fix it, not a bare `404`. |

**What it shows.** The chat panel lists every registered agent with its resolved provider and model, and streams a reply from the one you pick. The catalog lists each agent's `api_call` tools (with method and path), MCP servers, skills, and system prompt. MCP servers carry a connection status — `ok`, `stale`, `unknown`, or `unreachable` — derived from the tool cache with no network I/O, so the page renders instantly even when every declared server is down. A per-server **Probe** button forces a live `tools/list` when you actually want to know.

`unknown` and `unreachable` are different answers: the first means no run has ever needed that server and nobody has probed it, the second means the last attempt failed and carries the error.

**What it deliberately cannot do.** Nothing in the UI writes. Registration, manifest refresh, and deletion stay on `/apps/*` behind an app token; providers and limits stay in the environment. There is no server-side conversation history — a chat thread lives in the browser tab and ends with it.

**How chat reaches the provider.** The browser posts to `POST /internal/chat`, which runs the same agent `/v1/chat/completions` runs and streams OpenAI-shaped SSE back. The gateway supplies its own credentials. `IRI_API_KEY` never reaches the browser — a page with no authentication that also held that key would hand it to anyone who could load the page, which is strictly worse than the unauthenticated surface itself.

**Working on the UI.** `npm run ui:dev` starts Astro's own dev server on port 4321 with hot reload; it reaches `/internal/*` cross-origin, so run the gateway alongside it. The container image builds `ui/dist` in its own stage and copies only the output, so no frontend toolchain ships in the runtime layer.

## Tests

```bash
npm test               # unit + integration (vitest)
npm run typecheck      # tsc --noEmit
IRI_E2E=1 npm run test:e2e   # real Anthropic call (manual, spends tokens)
```

`npm test` runs offline and needs no provider credentials. Type checking is a
separate gate: Node strips types to run the sources, so `tsc` is what catches
type errors — including non-erasable syntax that would only fail at startup.

## Docker

```bash
docker build -t iriguchi .
docker run -d --name iriguchi \
  -p 4000:4000 \
  -v iriguchi-data:/data \
  --env-file .env \
  iriguchi
```

The image runs as a non-root user and takes all configuration from the
environment — nothing is baked in, and startup fails if `IRI_API_KEY`,
`IRI_REGISTRATION_SECRET`, or a provider triple is missing. The registry
database lives on the `/data` volume (`IRI_DB_PATH=/data/iriguchi.db`) so
registered apps survive replacing the container; `/tmp/iri` is disposable
scratch. Health is reported at `/healthz`.

## Layout

See `docs/superpowers/specs/2026-06-01-iriguchi-ai-gateway-design.md` for the full design.

```
src/
├── server.ts               # Hono app, startup, conditional /ui + /internal mounts
├── routes/openai.ts        # /v1/* — chat + models
├── routes/internal.ts      # /internal/* — catalog, MCP status, chat proxy (UI only)
├── routes/chat-run.ts      # SSE response machinery shared by /v1 and /internal
├── routes/registration.ts  # /apps/* — register, refresh, delete
├── internal/
│   ├── catalog.ts          # Registry → UI payloads; the redaction boundary
│   └── mcp-status.ts       # Connection status over the tool cache, plus probe
├── agent/
│   ├── runner.ts           # Wraps Claude Agent SDK query()
│   ├── tools.ts            # Dispatch by tool type; api_call → HTTP
│   ├── mcp/                # MCP client: pool, tool cache, discovery, invoke
│   ├── skills.ts           # Materialize skills to tempdir
│   ├── openai-sse.ts       # SDK events → OpenAI SSE chunks
│   └── json-schema-to-zod.ts  # JSON Schema → ZodRawShape for SDK tools
├── registry/
│   ├── store.ts            # SQLite store
│   ├── manifest.ts         # /agents-manifest fetcher
│   ├── refresher.ts        # Background TTL refresh
│   └── schema.ts           # Zod schemas
├── auth.ts                 # Bearer middleware
├── config.ts               # Env loader
└── logger.ts               # Structured JSON logger

ui/                         # Astro static client, built to ui/dist
├── DESIGN.md               # Design system: tokens, components, a11y rules
└── src/
    ├── styles/             # tokens.css (every visual decision) + base.css
    ├── layouts/Base.astro  # App shell
    ├── lib/api.ts          # Typed /internal/* client + SSE reader
    └── pages/              # index.astro (chat), agents.astro (catalog)
```
