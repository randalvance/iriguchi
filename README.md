# Iriguchi

Iriguchi (Japanese: "entrance / gateway") is an AI gateway: a single OpenAI-compatible chat endpoint that runs Claude Agent SDK-powered agents on behalf of other applications. Apps register themselves with the gateway and expose a `/agents-manifest` endpoint describing their agents, tools, and skills. Other apps don't need to embed agent logic — they just call this gateway.

- **Stack:** Bun, Hono, Zod, `@anthropic-ai/claude-agent-sdk`, `bun:sqlite`.
- **OpenAI compat:** Vanilla `/v1/chat/completions` works with OpenWebUI, OpenCode, and other OpenAI-compatible clients. App-aware mode is opt-in via the `iri_agent` field.
- **Multi-provider:** Named Anthropic-shaped backends configured side by side — Anthropic direct, OpenRouter's Anthropic endpoint, or local Ollama (≥ 0.14.0) / LM Studio (≥ 0.4.1), both of which expose the Anthropic `/v1/messages` API natively. Agents pick their provider in their manifest.

## Quickstart

0. Install [Bun](https://bun.sh) if you don't have it (or use the repo's devcontainer):
   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```
1. Copy `.env.example` to `.env` and fill in `IRI_API_KEY`, `IRI_REGISTRATION_SECRET`, and at least one provider triple (`IRI_PROVIDER_<NAME>_API_KEY` / `_BASE_URL` / `_DEFAULT_MODEL`). For a local LM Studio provider, start LM Studio's server (default port 1234) and use the model id it reports at `/v1/models`.
2. Start the gateway:
   ```bash
   bun install
   bun run dev
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
   bun install
   IRI_REGISTRATION_SECRET=$(grep IRI_REGISTRATION_SECRET ../../.env | cut -d= -f2) bun run dev
   ```
5. Open <http://localhost:4001> and ask "What's the weather in NYC?"

## Providers

Iriguchi routes each request to a named Anthropic-shaped backend. Configure providers via env vars — all three vars are required per provider:

```bash
IRI_PROVIDER_ANTHROPIC_API_KEY=sk-ant-...
IRI_PROVIDER_ANTHROPIC_BASE_URL=https://api.anthropic.com
IRI_PROVIDER_ANTHROPIC_DEFAULT_MODEL=claude-opus-5

IRI_PROVIDER_OPENROUTER_API_KEY=sk-or-...
IRI_PROVIDER_OPENROUTER_BASE_URL=https://openrouter.ai/api/v1/anthropic
IRI_PROVIDER_OPENROUTER_DEFAULT_MODEL=moonshotai/kimi-k3

IRI_DEFAULT_PROVIDER=anthropic
```

Only providers speaking the Anthropic `/v1/messages` API are supported today (Anthropic direct, OpenRouter's Anthropic endpoint, LM Studio ≥ 0.4.1, Ollama ≥ 0.14.0, Bedrock/Vertex Claude, or any Anthropic-compat proxy) — but any model behind such an endpoint works, not just Claude. Non-Anthropic-shaped providers (raw OpenAI shape) are out of scope for v1.

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

## App-aware usage

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
bun test               # unit + integration
bun run typecheck      # tsc --noEmit
IRI_E2E=1 bun run test:e2e   # real Anthropic call (manual, spends tokens)
```

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
