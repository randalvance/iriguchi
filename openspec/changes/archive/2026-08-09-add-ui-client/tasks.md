## 1. Configuration and mounting

- [x] 1.1 Add `IRI_UI_ENABLED` (boolean, default `false`) and `IRI_UI_DIST` (default `./ui/dist`) to `src/config.ts`, with the same validation style as the existing vars
- [x] 1.2 In `src/server.ts`, mount `/internal` and the `/ui` static handler only when `uiEnabled` is true, and emit a startup `warn` naming the unauthenticated exposure
- [x] 1.3 Serve `/ui` from `IRI_UI_DIST` via `@hono/node-server`'s `serveStatic`, returning a "UI not built; run `npm run ui:build`" response when the directory is missing
- [x] 1.4 Add both vars to `.env.example` with a comment stating the surface is unauthenticated
- [x] 1.5 Test: with the flag unset, `/internal/agents` and `/ui` return `404`, and `/v1` still requires a bearer token

## 2. Registry read helpers

- [x] 2.1 Add a store-level (or route-level) helper that flattens registered apps into agent records, skipping apps with a null manifest
- [x] 2.2 Add provider/model resolution shared with the run path so an agent omitting `provider` or `default_model` reports the resolved values, not blanks
- [x] 2.3 Write the payload mappers: catalog entry and agent detail, built field by field, redacting MCP header values to names and never touching `app_token`
- [x] 2.4 Test: flattening across two apps, inherited provider/model resolution, null-manifest app contributes nothing

## 3. MCP status and probe

- [x] 3.1 Add a last-attempt outcome map in the internal layer keyed by `connectionKey`, recording failures from probes and (if cheaply reachable) from lazy discovery; leave `ToolCache` and `CacheEntry` unchanged
- [x] 3.2 Implement status derivation over `ToolCache.entries()`/`peek()` producing `ok` / `stale` / `unknown` / `unreachable` with tool count and timestamp, performing no network I/O
- [x] 3.3 Implement the probe path: resolve `(agentId, serverName)` from the stored manifest, run discovery, populate the cache on success, record and return the error on failure — never accepting a URL or headers from the request
- [x] 3.4 Test: unknown vs unreachable are distinct; expired cache reads `stale` and keeps its tool count; a shared URL+headers pair yields one entry naming both agents; status read attempts no connection when all servers are down; probing an undeclared server is `404` with no outbound request

## 4. Internal API routes

- [x] 4.1 Create `src/routes/internal.ts` with no auth middleware and JSON error bodies matching the gateway's existing error shape
- [x] 4.2 `GET /internal/agents` — the flattened catalog
- [x] 4.3 `GET /internal/agents/:agentId` — detail with `api_call` tools, MCP servers, skills, system prompt; `404` on unknown id
- [x] 4.4 `GET /internal/mcp/servers` — deduped status entries
- [x] 4.5 `POST /internal/agents/:agentId/mcp/:serverName/probe` — live probe outcome
- [x] 4.6 Test: a secrets sweep asserting no `/internal/*` response body contains any stored app token or MCP header value

## 5. Chat proxy

- [x] 5.1 Extract the streaming agent-run logic from `src/routes/openai.ts` into a function both routes call, leaving `/v1/chat/completions` behavior byte-for-byte unchanged
- [x] 5.2 Implement `POST /internal/chat` over that function: validate `{ agent_id, messages }` with Zod, resolve the agent, stream OpenAI-shaped SSE ending in `data: [DONE]`
- [x] 5.3 Confirm the same `IRI_MAX_AGENT_TURNS` and `IRI_REQUEST_TIMEOUT_MS` bounds apply, and that no self-directed HTTP call to `/v1` is made
- [x] 5.4 Test: unknown `agent_id` is `404` before any provider call; a mid-stream failure reaches the client rather than closing silently; no gateway or provider key appears in any response bytes
- [x] 5.5 Test: `/v1/chat/completions` regression suite still passes unchanged after the extraction

## 6. UI package scaffold

- [x] 6.1 Create `ui/` as an Astro + TypeScript project with `output: 'static'` and `base: '/ui'`, its own `package.json` and lockfile, keeping the existing `ui/src/styles/` and `ui/DESIGN.md` in place
- [x] 6.2 Add root `ui:dev` and `ui:build` scripts delegating to the `ui/` package; keep the gateway's own scripts build-free
- [x] 6.3 Add a typed `/internal/*` fetch client shared by both panels, with a single error-handling path
- [x] 6.4 Add the shared layout on the existing design system: import `ui/src/styles/base.css` once in the app layout, build the shell from `.app` / `.app-header` / `.app-nav` / `.app-main`, and add no CSS that hardcodes a color, spacing, font, or duration outside `ui/src/styles/tokens.css` (see `ui/DESIGN.md`)
- [x] 6.5 Add `ui/dist`, `ui/node_modules`, and Astro cache directories to `.gitignore` and `.dockerignore`

## 7. Chat panel

- [x] 7.1 Agent picker populated from `GET /internal/agents`, labeling each agent with owning app and resolved provider/model
- [x] 7.2 Transcript state that accumulates turns for the session and is sent with each request
- [x] 7.3 SSE reader that renders assistant text incrementally as chunks arrive
- [x] 7.4 Empty state when no agents are registered: explain and disable sending
- [x] 7.5 Error state: a failed or mid-stream-errored run shows the error, preserves prior turns, and leaves the input usable

## 8. Agent catalog view

- [x] 8.1 Catalog list: agent, owning app, description, resolved provider/model, and counts of `api_call` tools, MCP servers, and skills
- [x] 8.2 Agent detail: `api_call` tools with method and path, MCP servers with URL and header *names*, skills, and the system prompt behind a disclosure
- [x] 8.3 MCP health display: the four states visually distinguished, with tool count, timestamp, and the error message on `unreachable`
- [x] 8.4 Per-server probe control that updates the displayed status from the live outcome; no probes on page load
- [x] 8.5 Verify no control anywhere in the UI issues a write to `/apps/*` or to any gateway setting
- [x] 8.6 Catalog error state that names the failure and leaves the chat panel rendered

## 9. Packaging and docs

- [x] 9.1 Add a Dockerfile build stage that installs UI dependencies and produces `ui/dist`, copying only the built assets into the runtime layer
- [x] 9.2 Verify the built image ships no UI source or frontend toolchain, and that `/internal/*` and `/ui` are `404` with only the required env vars set
- [x] 9.3 README: a UI section covering `npm run ui:build`, `IRI_UI_ENABLED`, opening `/ui`, and an explicit warning that the surface is unauthenticated and the port must not be publicly reachable
- [x] 9.4 Run `npm test` and `npm run typecheck`; confirm both pass and that the offline test suite still needs no provider credentials
