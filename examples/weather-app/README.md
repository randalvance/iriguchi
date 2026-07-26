# Weather App — Iriguchi demo

A minimal Bun/Hono app that registers itself with the Iriguchi gateway, exposes one agent (`weather-bot`) with one `api_call` tool (`get_forecast`) and one inline skill (`weather-jargon`), and serves a static chat UI at `/`.

## Run

1. Start the gateway in one terminal:
   ```bash
   IRI_API_KEY=mykey \
   IRI_REGISTRATION_SECRET=regsecret \
   IRI_PROVIDER_ANTHROPIC_API_KEY=sk-... \
   IRI_PROVIDER_ANTHROPIC_BASE_URL=https://api.anthropic.com \
   IRI_PROVIDER_ANTHROPIC_DEFAULT_MODEL=claude-opus-5 \
   bun run dev
   ```
2. Start this app in another terminal:
   ```bash
   cd examples/weather-app
   IRI_REGISTRATION_SECRET=regsecret bun run dev
   ```
3. Open <http://localhost:4001>, paste `mykey` into the API key field, and ask "What's the weather in NYC?"
