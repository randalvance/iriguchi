## Why

Iriguchi has no face. Every interaction today is a `curl` or a third-party OpenAI-compatible client, and neither can answer the two questions an operator actually has: *what can this gateway do right now*, and *is it working*. The registry knows every app, agent, tool, and MCP server it has ever been told about, but none of that is readable from outside — `listApps()` has no HTTP surface, and MCP connection health exists only as an in-memory cache that no one can inspect. Debugging a broken MCP server means reading logs and guessing.

A first-party client fixes both: a chat panel that talks to a chosen agent without pasting an API key into someone else's tool, and a read-only catalog that shows every agent's tools, MCP servers, and whether those servers are reachable.

## What Changes

- **New `ui/` package** — an Astro + TypeScript app, built to static assets, living in this repo alongside the gateway. It is a *client*: it holds no gateway state and reaches everything over HTTP.
- **New internal HTTP surface, `/internal/*`** — JSON endpoints the UI consumes that the public API deliberately does not expose: the flattened agent catalog, per-agent tool and MCP detail, MCP connection probes, and a chat proxy. This is the "special access" that separates the first-party client from any OpenAI-compatible one.
- **The gateway serves the built UI at `/ui`** — static assets mounted from `ui/dist`, so one process and one port serve both. No CORS, no second server to run.
- **The internal surface is unauthenticated and opt-in.** Per the trusted-local-only decision, `/internal/*` and `/ui` carry no credential. They are therefore gated behind `IRI_UI_ENABLED` (default **off**), so the containerized deployment does not silently gain an unauthenticated admin surface on an already-published port. Enabling it logs a `warn` naming the exposure.
- **The browser never holds `IRI_API_KEY`.** Chat goes through `POST /internal/chat`, which injects the gateway's own credential server-side and streams the agent run back. A no-auth UI that also held the API key would hand the key to anyone who could reach the page.
- **MCP status becomes observable.** Discovery is lazy and cached today, with no way to ask "is this server up". A read-only status view over the MCP cache is added, plus an explicit on-demand probe, so the catalog can show reachable / stale / unreachable per server without a run having to fail first.
- **Feature scope is exactly two panels.** (1) A chat panel with an agent picker and streamed responses. (2) A **read-only** agent catalog — tools, MCP servers, skills, provider/model, connection health. No registration, no deletion, no config editing from the UI; those stay on `/apps/*` and the environment.
- **The repo gains a build step for the first time** — for the UI only. The gateway still runs its TypeScript directly.

## Capabilities

### New Capabilities
- `internal-api`: the `/internal/*` HTTP surface — its endpoints and payload shapes (agent catalog, agent detail, MCP server status and probe, chat proxy), the `IRI_UI_ENABLED` gate, the no-authentication boundary and what that boundary forbids, and how gateway credentials are kept server-side.
- `management-ui`: the shipped client — how it is served at `/ui`, the chat panel's agent selection and streaming behavior, the read-only agent catalog's contents and health presentation, and how the UI degrades when the gateway or an MCP server is unavailable.

### Modified Capabilities
- `runtime-platform`: "TypeScript sources execute without a build step" currently reads as a whole-repository rule. It is narrowed to the *gateway* and gains its counterpart — the UI is a separate package with its own build output, the gateway serves prebuilt assets and never builds at request time, and the container image is responsible for producing `ui/dist` while shipping no UI toolchain in the runtime layer.

## Impact

**Code**
- `ui/` (new) — Astro project, its own `package.json`, built to `ui/dist`.
- `src/routes/internal.ts` (new) — the `/internal/*` router, mounted only when enabled.
- `src/server.ts` — conditional mount of `/internal` and static `/ui`; boot warning when enabled.
- `src/config.ts` — `IRI_UI_ENABLED` (default `false`), `IRI_UI_DIST` (default `./ui/dist`).
- `src/agent/mcp/` — a status read over the existing cache plus an explicit probe entry point; discovery and invocation logic unchanged.
- `src/registry/store.ts` — read helpers for the flattened agent catalog (no schema change).
- `package.json` — `@hono/node-server` `serveStatic` usage; UI build scripts (`ui:dev`, `ui:build`).
- `Dockerfile` — a build stage that runs the UI build and copies `ui/dist` into the runtime image.
- `README.md`, `.env.example` — the new vars and how to open the UI.

**Depends on**
- `add-mcp-client` is implemented in `src/agent/mcp/` but not yet archived into `openspec/specs/`. The MCP status endpoint reads that cache, so this change assumes that code as it stands and should land after it settles.

**Not in scope**
- Authentication, multi-user, or remote/hosted deployment of the UI. The no-auth decision makes this a localhost/trusted-network tool; exposing it publicly is out of scope and explicitly warned against.
- Any write operation against the registry from the UI.
- Persisted conversation history — chat threads live in the browser session only.
