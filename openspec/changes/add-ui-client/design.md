## Context

The gateway is a headless Hono server: `/v1/*` (bearer-authenticated OpenAI surface), `/apps/*` (registration, app-token-authenticated), `/healthz`. TypeScript runs directly through Node with no build step, and the container image reflects that — it copies sources and runs them.

Everything the UI needs to show already exists in memory or SQLite but has no reader:

- `store.listApps()` returns `StoredApp[]`, each carrying a validated `Manifest` with its `agents[]`, and each agent its `tools[]` (`api_call` | `mcp`), `skills[]`, `provider`, `default_model`. `StoredApp` also carries `app_token` — a secret that must not cross into any UI payload.
- The MCP `ToolCache` (`src/agent/mcp/cache.ts`) holds one `CacheEntry` per `connectionKey(url, headers)` with `tools[]` and `fetched_at`. It records successes only: a failed `tools/list` leaves no trace, and discovery is lazy, so a server that has never been needed is indistinguishable from one that is down.

Two constraints shape the rest. The operator chose **trusted-local-only, no auth**, which means the new surface cannot be exposed the way `/v1` is. And the operator chose **Astro**, which means the repo acquires a build step it has never had.

## Goals / Non-Goals

**Goals:**
- One process, one port: `npm start` serves the gateway and the UI.
- A chat panel that picks an agent from the live registry and streams its response.
- A read-only agent catalog that answers "what tools does this agent have, and are its MCP servers up" without reading logs.
- Keep `IRI_API_KEY` out of the browser entirely.
- Leave `/v1/*` and `/apps/*` byte-for-byte unchanged.

**Non-Goals:**
- Authentication, sessions, or multi-user support.
- Any write to the registry from the UI (register, refresh, delete stay on `/apps/*`).
- Server-persisted conversation history.
- A remotely exposed deployment of the UI.

## Decisions

### Astro in static output, served by Hono

`ui/` is an Astro project with `output: 'static'` and `base: '/ui'`, built to `ui/dist`. The gateway mounts it with `@hono/node-server`'s `serveStatic` at `/ui`, rewriting the request path into `IRI_UI_DIST`. All data arrives client-side from `/internal/*`.

*Why static over SSR:* an SSR Astro adapter would put a second runtime inside the gateway process and give the UI direct access to the store, collapsing the client/server boundary the operator explicitly asked for ("a separate client"). Static keeps the UI honest — it can only see what `/internal/*` exposes, which is also what makes that surface reviewable.

*Why no UI framework integration:* both panels are small. The catalog is fetch-and-render; the chat panel is an append-only transcript plus an SSE reader. Plain client-side TypeScript in Astro `<script>` islands covers this without pulling React/Preact into a repo that has no frontend dependencies today. *Alternative considered:* adding `@astrojs/preact` for the chat panel — deferred; revisit if the transcript grows real state (editing, branching, retries).

### `/internal/*` is a distinct router, mounted only when enabled

`src/routes/internal.ts` is mounted from `server.ts` only when `IRI_UI_ENABLED` is true, alongside the `/ui` static mount. Default is **false**.

*Why a gate at all when the decision was "no auth":* the gateway ships as a container that publishes port 4000. An unauthenticated admin surface that appears by default on that port is a different security posture than the one that was chosen — "trusted local network" has to be an assertion the operator makes, not one the image makes for them. Enabling it emits a startup `warn` naming the exposure. This is a safety rail on the chosen design, not a substitute for it: when enabled, there is no credential.

*Why `/internal` rather than `/admin`:* it is read-mostly and it is the private counterpart to `/v1`; "admin" overstates what it can do (nothing in it mutates the registry).

### Chat is proxied, not called directly

`POST /internal/chat` takes `{ agent_id, messages }`, resolves the agent through the store, runs it through the same code path `/v1/chat/completions` uses in streaming mode, and streams OpenAI-shaped SSE back to the browser.

*Why not have the UI call `/v1/chat/completions`:* that endpoint requires `Authorization: Bearer $IRI_API_KEY`. With no auth on the UI, shipping the key to the browser would hand it to anyone who can load the page — strictly worse than the no-auth surface itself, because the key also unlocks the *authenticated* API. Proxying keeps the credential in the process.

*Implementation note:* the shared run logic is extracted into a function both routes call. `/internal/chat` must not issue an HTTP request back to the gateway's own `/v1` — that would need the key it is trying not to have, and would double the request path.

### MCP health is derived from the cache, plus an explicit probe

Status per declared server, keyed by `connectionKey`:

| State | Meaning |
|---|---|
| `ok` | Cache entry younger than `IRI_MCP_CACHE_TTL_MS`, or a probe just succeeded |
| `stale` | Cache entry exists but is older than the TTL |
| `unknown` | No cache entry — no run has ever needed this server, and it has not been probed |
| `unreachable` | The most recent probe or discovery attempt failed; the error message is carried |

`GET /internal/mcp/servers` reports this without any network I/O, so loading the catalog never blocks on a dead server. `POST /internal/agents/:agentId/mcp/:serverName/probe` forces a `tools/list` and returns the live outcome.

*Why the probe is scoped to a declared server rather than taking a URL:* an unauthenticated endpoint that accepts an arbitrary URL and fetches it is an SSRF primitive pointed at the gateway's network. Resolving `(agentId, serverName)` through the registry means a probe can only reach a server some registered manifest already declared — which the existing `IRI_MCP_ALLOWED_ORIGINS` check has already vetted.

*Why failures are tracked outside `ToolCache`:* `CacheEntry` models a successful `tools/list` and is consumed by discovery, invocation, and the background refresher. Adding a failure field would make every consumer handle an entry with no tools. Instead the internal layer keeps a small module-scoped map of last-probe outcomes keyed the same way. *Alternative considered:* a `lastError` on `CacheEntry` — rejected as a wider blast radius for a read-only feature.

### Payload shaping is explicit, never pass-through

`/internal/*` responses are built field by field from `StoredApp`/`Manifest`, never by serializing the stored objects. `app_token` is the reason: it sits on `StoredApp` next to the manifest, and one `c.json(app)` would publish it on an unauthenticated endpoint. MCP `headers` are the same hazard — they may hold a bearer token — so the catalog reports header *names* only, never values.

### The build step is the UI's alone

`ui/` has its own `package.json` and `node_modules`; the root gains `ui:dev` and `ui:build` scripts that delegate. The gateway continues to run `src/*.ts` directly and never invokes a bundler at request time. The Dockerfile gains a build stage that produces `ui/dist` and copies only the output into the runtime image, so no frontend toolchain ships in the final layer.

## Risks / Trade-offs

- **An unauthenticated admin surface on a published port** → default-off `IRI_UI_ENABLED`, a startup `warn` when enabled, README guidance to bind to loopback or keep the port unpublished, and no write operations anywhere in the surface. The residual risk is real and accepted: anyone who reaches the port with the flag on can read the catalog and spend tokens through the chat proxy.
- **Secret leakage through convenience serialization** → explicit field-by-field payload construction, header values redacted to names, and a test asserting no `/internal/*` response body contains an app token.
- **Chat proxy as an unmetered spend path** → it runs the same agents `/v1` runs and is bounded by the same `IRI_MAX_AGENT_TURNS` and `IRI_REQUEST_TIMEOUT_MS`. No additional rate limiting; noted rather than solved.
- **Stale `ui/dist`** → a `/ui` request with no built assets returns a clear "UI not built; run `npm run ui:build`" message rather than a bare 404. The Dockerfile always builds fresh.
- **Probe hides intermittency** → a probe result is a point-in-time fact and is labeled with its timestamp in the UI. It is not a monitor.
- **Coupling to in-flight `add-mcp-client`** → the status read touches only `ToolCache.entries()`/`peek()` and the discovery entry point, both stable surfaces. If that change is still moving, this one lands after it.

## Migration Plan

Additive; nothing to migrate. Deploy order: build the UI, set `IRI_UI_ENABLED=true` where it is wanted, restart. Rollback is unsetting the flag — the gateway then serves exactly what it serves today, because both mounts are conditional.

## Open Questions

- Should the catalog surface each agent's system prompt? It is visible to any registering app's author and useful for debugging, but it is the largest single blob in the payload. Leaning toward including it collapsed behind a disclosure.
- Whether `IRI_UI_ENABLED=true` should additionally refuse to start when the server is bound to a non-loopback address. Deferred: the gateway does not currently expose a bind-address setting.
