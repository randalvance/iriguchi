# Iriguchi

Iriguchi (Japanese: "entrance / gateway") is an AI gateway: a single OpenAI-compatible chat endpoint that runs Claude Agent SDK-powered agents on behalf of other applications. Apps register themselves with the gateway and expose a `/agents-manifest` endpoint describing their agents, tools, and skills. Other apps don't need to embed agent logic — they just call this gateway.

- **Stack:** Bun, Hono, Zod, `@anthropic-ai/claude-agent-sdk`, `bun:sqlite`.
- **OpenAI compat:** Vanilla `/v1/chat/completions` works with OpenWebUI, OpenCode, and other OpenAI-compatible clients. App-aware mode is opt-in via the `iri_agent` field.
- **Local LLM:** Set `ANTHROPIC_BASE_URL` to point at Ollama (≥ 0.14.0) or LM Studio (≥ 0.4.1), both of which expose the Anthropic `/v1/messages` API natively.

## Quickstart

1. Copy `.env.example` to `.env` and fill in `ANTHROPIC_API_KEY`, `IRI_API_KEY`, `IRI_REGISTRATION_SECRET`.
2. Start the gateway:
   ```bash
   bun install
   bun run dev
   ```
3. (Optional) Start the demo weather app in another terminal:
   ```bash
   cd examples/weather-app
   bun install
   IRI_REGISTRATION_SECRET=$(grep IRI_REGISTRATION_SECRET ../../.env | cut -d= -f2) bun run dev
   ```
4. Open <http://localhost:4001> and ask "What's the weather in NYC?"

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
