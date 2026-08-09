# Weather App — Iriguchi demo

A minimal Node/Hono app that registers itself with the Iriguchi gateway, exposes one agent (`weather-bot`) with two `api_call` tools (`get_forecast`, `save_location`) and one inline skill (`weather-jargon`), and serves a static chat UI at `/`.

The UI is also page-aware: whichever city you are viewing is sent to the gateway as `iri_context`, so the agent can answer questions about "this city" without you naming it. See [things to try](#things-to-try) below.

## Run

1. Start the gateway in one terminal:
   ```bash
   IRI_API_KEY=mykey \
   IRI_REGISTRATION_SECRET=regsecret \
   IRI_PROVIDER_ANTHROPIC_API_KEY=sk-... \
   IRI_PROVIDER_ANTHROPIC_BASE_URL=https://api.anthropic.com \
   IRI_PROVIDER_ANTHROPIC_DEFAULT_MODEL=claude-opus-5 \
   npm run dev
   ```
2. Start this app in another terminal:
   ```bash
   cd examples/weather-app
   IRI_REGISTRATION_SECRET=regsecret npm run dev
   ```
3. Open <http://localhost:4001>, paste `mykey` into the API key field, and ask "What's the weather in NYC?"

## Things to try

Pick a city with the buttons above the chat log. The panel shows exactly what the app sends as `iri_context` on every message:

```jsonc
{
  "route": "/city/new-york",     // scalar → goes into the agent's system prompt
  "city": "New York",
  "units": "imperial",
  "today": "2026-08-09",
  "saved_locations": [],
  "forecast": [ /* 7 days */ ]   // nested → placeholder only; read via get_context
}
```

| Ask this | What it demonstrates |
| --- | --- |
| Select New York, then **"will I need an umbrella tomorrow?"** | The agent resolves "here" from `city` in the context block. You never named the city. |
| **"which day this week is best for a picnic?"** | The forecast is already on screen, so the agent calls `get_context` for `forecast` instead of `get_forecast`. Watch the app's console: no `/api/forecast` request. |
| **"what about Tokyo?"** | Tokyo is not the screen's city, so the agent falls back to the `get_forecast` tool. This time `/api/forecast` *is* called. |
| **"save this city"** | `save_location` carries `when: { "route": { "prefix": "/city/" } }`, so it exists only while a city is selected. The saved list updates. |
| Click **Home**, then **"save this city"** | The route is now `/`, the `when` clause does not match, and the tool is not offered at all — the agent has to say it can't. The gateway logs the drop as `tools.filtered` at `debug`. |

The last two rows are the point of `when`: the same agent has a different tool surface depending on the screen, with no branching in this app's code.

## How the pieces map

- `src/manifest.ts` — the agent, its tools, and the `when` clause on `save_location`.
- `src/server.ts` — tool endpoints (app-token authenticated) plus `GET /api/screen`, which is what the browser reads. That one is **not** a tool endpoint: it is the app's own front end calling its own API, and in a real app it would be session-authenticated. The app token is for the gateway, and no browser should hold it.
- `public/index.html` — renders the screen and sends the same object as `iri_context`.
