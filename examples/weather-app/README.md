# Weather App — Iriguchi demo

A minimal Node/Hono app that registers itself with the Iriguchi gateway, exposes one agent (`weather-bot`) with two `api_call` tools (`get_forecast`, `save_location`) and one inline skill (`weather-jargon`), and serves a static page at `/` whose chat is the reusable [`@iriguchi/chat-ui`](../../packages/chat-ui) client — the same panel any Iriguchi-registered app can adopt.

The UI is page-aware: whichever city you are viewing is registered as `iri_context` slices, so the agent can answer questions about "this city" without you naming it. See [things to try](#things-to-try) below.

This example is deliberately buildless and framework-free. It loads the client's compiled ESM straight from `/chat-ui/`, which is also what proves that half of the package needs neither React nor a bundler.

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
2. Start this app in another terminal. It needs `IRI_API_KEY` now: the browser no longer holds one, so this process is what authenticates to the gateway.
   ```bash
   cd examples/weather-app
   npm install
   IRI_REGISTRATION_SECRET=regsecret IRI_API_KEY=mykey npm run dev
   ```
3. Open <http://localhost:4001>, click **Ask AI** on the right edge, and ask "What's the weather in NYC?"

`npm install` links `@iriguchi/chat-ui` from `packages/chat-ui` by path and builds it. If your npm blocks install scripts, build it once by hand: `npm run chat-ui:build` from the repository root.

| Variable | Purpose |
| --- | --- |
| `IRI_API_KEY` | Presented to the gateway by this app's `/api/ask-ai` proxy route. Never sent to the browser. |
| `IRI_GATEWAY_URL` | Gateway base URL. Defaults to `http://localhost:4000`. |
| `IRI_REGISTRATION_SECRET` | Registers the app and its manifest at startup, as before. |

## Things to try

Pick a city with the buttons on the page, then open **Ask AI**. Each thing the page owns is registered as its own slice, and the merged envelope is re-derived on every message:

```js
chat.registry.register("route", () => screen.route);              // scalar → system prompt
chat.registry.register("city", () => screen.city);                // scalar → system prompt
chat.registry.register("today", () => screen.today);              // scalar → system prompt
chat.registry.register("forecast", () => screen.forecast, { truncate: true });  // array → get_context
```

which merges to:

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

Because slices are read at send time, walking to another city changes what the *next* message carries. Earlier turns keep what they were told as text, but the agent cannot `get_context` into a screen you have left.

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
- `src/server.ts` also mounts `createIriguchiChatProxy` at `POST /api/ask-ai` and serves the client's `dist/` at `/chat-ui/`.
- `public/index.html` — renders the screen, registers each part of it as a context slice, and mounts the Ask AI panel.

## Trying the client itself

| Do this | What it demonstrates |
| --- | --- |
| Watch the reply appear word by word | Streaming SSE, rendered as it arrives rather than after the ~40s run |
| Press **Stop** mid-reply | The partial text stays, marked *Stopped* — a cancelled run is not an error |
| Reload the page | The conversation is restored from `localStorage`; the context is not, and never was stored |
| Press **Clear conversation** | Transcript and stored thread both go |
| Open devtools → Network | The browser talks only to this app's origin, and carries no gateway key |
