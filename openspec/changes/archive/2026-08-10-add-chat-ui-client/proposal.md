## Why

The gateway can already answer questions about the screen a user is looking at — `iri_context` inlines scalars, summarizes payloads, and serves them on demand through `get_context` — but nothing consumes it. Every app that wants an embedded "Ask AI" panel today has to write its own SSE reader, its own conversation store, its own key-hiding proxy, and its own context plumbing. At least two apps want that panel (first: a Next.js 15 App Router finance app), and the eventual goal — chat that *drives* the host UI — needs an interactive run protocol in the gateway, not in each app. That is why this belongs in Iriguchi.

## What Changes

- Add `packages/chat-ui`, a new sibling npm project (`@iriguchi/chat-ui`) following the `ui/` convention: its own `package.json` and `tsconfig.json`, driven by root scripts, not an npm workspace member.
- **Context registry**: any component registers a named context slice with a callback; the SDK merges the registered slices into one `iri_context` object at send time. Callbacks may be async. Unmounting removes the slice. Each slice becomes one top-level key, which lines up with the gateway's two tiers — scalars ride free every turn, arrays and objects cost tokens only when `get_context` reads them.
- **Streaming transport**: `stream: true` against `/v1/chat/completions`, an SSE reader that renders `chat.completion.chunk` deltas token by token, with in-flight cancellation and a defined presentation for an error that arrives after tokens have rendered.
- **Client-held history** persisted to `localStorage` under a versioned key, capped by turn count and byte size, with an explicit "Clear conversation" action. Messages only — `iri_context` is never persisted.
- **Server proxy factory**: `createIriguchiChatProxy({ gatewayUrl, apiKey })` returns a framework-agnostic `(Request) => Promise<Response>` that streams SSE through unchanged, so `IRI_API_KEY` never reaches the browser. Next 15 route handlers accept it directly; other frameworks get documented adapters.
- **React binding and a prebuilt panel**: `IriguchiChatProvider`, `useIriContext`, `useIriChat`, and an `AskAiPanel` — an edge-pinned "Ask AI" button that slides out a chat panel. The hooks are the contract; the panel is a replaceable reference implementation styled through CSS custom properties in a single importable stylesheet, requiring no Tailwind or design system in the host.
- **Client-side context size enforcement** ahead of the gateway's 400, with an error naming the offending slice, and a per-slice opt-in to truncation instead of a failed send.
- **Forward accommodation for phase C only** — the registration API's types reserve room for client-executed actions so `useIriAction` can land without a breaking change, and the design records (non-normatively) the interactive run protocol the gateway will need. No gateway change ships here.
- **`examples/weather-app` becomes the working demo of the client.** It links the package by path, mounts the proxy on its own Hono server, drops the API-key input from the browser, registers its screen state as context slices, and replaces its hand-rolled SSE reader with the SDK's. Because that example is deliberately buildless and non-React, it exercises the framework-agnostic half of the package directly — which is what keeps that boundary honest.
- Root `package.json` gains `chat-ui:install` / `chat-ui:build` / `chat-ui:check` / `chat-ui:test` scripts so CI sees the package.
- New adoption guide at `docs/chat-ui-client.md`, linked from `docs/app-integration.md` step 6.

Not in scope: non-React bindings, server-side conversation persistence, gateway-minted browser tokens and CORS, and the phase C interactive run protocol itself. Each is recorded as a follow-up.

## Capabilities

### New Capabilities
- `chat-ui-client`: the embeddable chat client — context slice registration and merge, streaming request/response handling, conversation persistence, cancellation and error presentation, panel behavior and theming, and the server-side proxy that keeps the gateway key out of the browser.

### Modified Capabilities
<!-- None. The gateway's request contract is unchanged; this change is a consumer of client-context, provider-routing, and chat-completions-protocol as they already are. -->

## Impact

- **New**: `packages/chat-ui/` (source, tests, its own toolchain), `docs/chat-ui-client.md`.
- **Modified**: root `package.json` scripts; `docs/app-integration.md` (pointer from step 6); `README.md` repo-layout note; `examples/weather-app` (server gains a proxy route and a static mount, page swaps its inline chat implementation for the SDK, README updated). The example's manifest, tool endpoints, and `when` clause are unchanged — the demo it teaches stays the same, only the client half of it changes.
- **Unmodified**: `src/**` — no gateway behavior changes, so `openspec/specs/client-context`, `chat-completions-protocol`, and `app-registration` are consumed as-is.
- **Dependencies**: React ≥ 18 as a peer dependency; no runtime dependencies in core or the proxy. Consumers install from a git ref; local development links by path.
- **Consumers**: the finance app adopts it by declaring its own `finance-chat` agent, mounting the proxy route, and calling `useIriContext` — no new tools needed there.
- **Testing**: the package's tests run offline with no credentials, matching the gateway's standard; `npm test` and `npx tsc --noEmit` stay clean at the root and in the package.
