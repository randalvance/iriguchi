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
├── server.ts               # Hono app, startup
├── routes/openai.ts        # /v1/* — chat + models
├── routes/registration.ts  # /apps/* — register, refresh, delete
├── agent/
│   ├── runner.ts           # Wraps Claude Agent SDK query()
│   ├── tools.ts            # api_call tool → HTTP
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
```
