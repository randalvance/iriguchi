## 1. Package scaffolding

- [x] 1.1 Create `packages/chat-ui/` with its own `package.json` (`@iriguchi/chat-ui`, ESM only, React as a peer dependency, no runtime dependencies) and `tsconfig.json`, following the `ui/` sibling-project convention — not a workspace member
- [x] 1.2 Define the `exports` map: `.`, `./core/panel`, `./react`, `./react/panel`, `./server`, `./styles.css`, each with types; add the `prepare` build script (`tsc` to `dist/` plus the CSS copy) and keep `dist/` out of git
- [x] 1.3 Add `chat-ui:install` / `chat-ui:build` / `chat-ui:check` / `chat-ui:test` to the root `package.json`
- [x] 1.4 Add the package's own vitest config with a DOM environment for the React layer and a node environment for `core/` and `server/`
- [x] 1.5 Add a lint or test guard enforcing the import boundary: `core/` imports no React, `server/` imports no React and touches no DOM global
- [x] 1.6 Verify the gateway is unaffected — root `npm test` and `npx tsc --noEmit` pass and compile nothing under `packages/`

## 2. Core: context registry

- [x] 2.1 Implement the slice registry: register/deregister by key, last-wins on duplicates with a development-only warning naming the key
- [x] 2.2 Implement resolution at send: invoke every callback, await promises, bound each by a timeout, drop a slice that throws/rejects/times out and report it through the error channel
- [x] 2.3 Implement the merge into a single object, returning `undefined` (so the field is omitted) when no slices are registered
- [x] 2.4 Tests: composition across sibling registrations, deregistration on unmount, async resolution, failure isolation, duplicate-key behavior, empty-registry omission

## 3. Core: size accounting and truncation

- [x] 3.1 Serialize the merged context and compare against `maxContextBytes` (default 65536)
- [x] 3.2 On overflow, compute per-slice sizes and raise an error naming the limit, the observed size, and the largest slice
- [x] 3.3 Implement `{ truncate: true }`: shrink array-valued slices from the end until the context fits, replacing the value with `{ truncated: true, total, kept, items }`; leave non-array slices untouched and fail if truncation cannot bring it under the limit
- [x] 3.4 Tests: under-limit passthrough, over-limit error naming the right slice, successful rescue by truncation, truncation marker present in the sent context, unrescuable overflow still fails

## 4. Core: transport

- [x] 4.1 Implement request assembly — `iri_agent`, full message history, `stream: true`, `iri_context` when non-empty — against the configured endpoint
- [x] 4.2 Implement the SSE reader: parse `data:` frames, apply `chat.completion.chunk` text deltas, terminate on `[DONE]`, ignore unrecognized chunk fields rather than aborting
- [x] 4.3 Wire `AbortController` for cancellation and surface abort distinctly from failure
- [x] 4.4 Classify failures by position: non-2xx before the body opens parses the gateway's JSON error body and surfaces `code` and message; a break after the body opened keeps received text and reports the reason
- [x] 4.5 Tests: incremental delta emission, `[DONE]` termination, unknown-field tolerance, abort mid-stream, pre-stream 400 with `context_too_large`, mid-stream connection drop

## 5. Core: conversation store

- [x] 5.1 Implement load/save against `localStorage` under `iriguchi.chat.v1.<agentId>` holding `{ v, messages }`
- [x] 5.2 Discard on version mismatch, parse failure, or shape mismatch rather than migrating
- [x] 5.3 Apply both caps on write — 40 messages and 128 KiB serialized, oldest-first — and persist messages only, never context
- [x] 5.4 Wrap all storage access so a quota error, disabled storage, or an absent `localStorage` (SSR) degrades to an in-memory session
- [x] 5.5 Implement `clear()` removing both the in-memory transcript and the stored thread
- [x] 5.6 Tests: round-trip restore, stale-version discard, corrupt-payload discard, both caps, no context or slice values in the stored payload, quota failure non-fatal, clear removes both copies

## 6. Server proxy

- [x] 6.1 Implement `createIriguchiChatProxy({ gatewayUrl, apiKey })` returning `(Request) => Promise<Response>`
- [x] 6.2 Attach the bearer credential server-side, forward the body to `/v1/chat/completions`, and return the upstream response with its body stream intact and status and error body verbatim
- [x] 6.3 Propagate caller abort to an `AbortController` on the upstream fetch
- [x] 6.4 Tests against a stubbed upstream `fetch`: header attachment, unbuffered pass-through, error status and body passed verbatim, abort propagation, and invocation with a bare `Request` in a node environment with no React resolvable

## 7. React binding

- [x] 7.1 Implement `IriguchiChatProvider` (endpoint, agent, optional `maxContextBytes` and `onError`) owning the registry, transport, and store
- [x] 7.2 Implement `useIriContext(key, callback, options?)` registering on mount and deregistering on unmount
- [x] 7.3 Implement `useIriChat()` exposing `messages`, `send`, `cancel`, `clear`, and per-turn status (`streaming` / `complete` / `cancelled` / `error`)
- [x] 7.4 Ensure history and panel state survive client-side navigation and that changing slices never resets the thread
- [x] 7.5 Tests with Testing Library over a stubbed `fetch`: streaming render, cancel keeps partial text as cancelled, both error positions, persistence across remount, slice lifecycle across simulated navigation, thread continuity across a route change

## 8. Panel and styles

- [x] 8.1 Implement `mountAskAiPanel(container, chat)` in `core/panel`: right-edge vertically centered "Ask AI" button, slide-out surface, transcript, composer, cancel while in flight, "Clear conversation" — subscribing to the core chat store, with an unmount that removes the DOM and releases subscriptions
- [x] 8.2 Implement focus management (into the surface on open, back to the control on close), `Escape` to dismiss, and real button elements throughout
- [x] 8.3 Write `styles.css` — every value a `--iri-chat-*` custom property defaulting to `ui/DESIGN.md`'s vocabulary, all selectors `iri-chat-` prefixed, no element or reset rules, motion collapsing under `prefers-reduced-motion`
- [x] 8.4 Render assistant text as plain text with preserved whitespace (no markdown, no HTML insertion) and the streaming caret convention; asymmetric turns per the design system
- [x] 8.5 Implement the React `AskAiPanel` as a thin wrapper that mounts and unmounts the framework-agnostic panel — no second DOM implementation
- [x] 8.6 Tests: open/close and focus return, keyboard reachability of every action, reduced-motion path, markdown and HTML rendered literally, clean unmount, and a hooks-only host rendering without the panel or its stylesheet

## 9. Phase C accommodation

- [x] 9.1 Type the registry with a kind so an action registration can be added later without changing `useIriContext`'s signature or semantics
- [x] 9.2 Test that the emitted request body carries only fields the gateway's existing contract defines and nothing describing client-executed actions

## 10. Example app integration

- [x] 10.1 Add the package to `examples/weather-app` as a `file:` path dependency and serve `packages/chat-ui/dist/` from its Hono server under a static path
- [x] 10.2 Mount `createIriguchiChatProxy` at `POST /api/ask-ai`, reading the gateway URL and API key from the example's environment
- [x] 10.3 Rewrite the page's chat: import the client and `mountAskAiPanel` as plain browser ESM, drop the hand-rolled SSE reader, the history array, and the gateway URL and API key inputs
- [x] 10.4 Register the screen state as slices — `route`, `city`, `today`, `units` as scalars; `forecast` and `saved_locations` as payloads — replacing the single hand-assembled `iri_context` object
- [x] 10.5 Keep the demo's teaching intact: the forecast table still renders, the screen is re-read after a run so a `save_location` tool call is reflected, and the manifest, tool endpoints, `when` clause, and prompt are untouched
- [x] 10.6 Update `examples/weather-app/README.md` — new env vars, the removed key input, and what the slices demonstrate
- [x] 10.7 Verify by hand against a running gateway: streaming renders incrementally, `get_context` reads the forecast rather than `get_forecast` re-fetching it, `save_location` appears only on a city screen, and cancel and clear both behave

## 11. Documentation and release

- [x] 11.1 Write `docs/chat-ui-client.md`: install from a git tag and by path link, mount the proxy in Next 15 App Router plus one other framework, wrap the app in the provider, register slices, use or replace the panel, theme by custom properties
- [x] 11.2 Document the intended limitation — context is re-derived per turn, so the model retains what earlier turns told it as text but cannot `get_context` into a page the user has left
- [x] 11.3 Document the Next 15 runtime caveats for streaming route handlers and include a smoke-test snippet
- [x] 11.4 Link the guide from `docs/app-integration.md` step 6 and note the package in the `README.md` repo-layout section
- [x] 11.5 Verify the whole surface: root `npm test`, root `npx tsc --noEmit`, `npm run chat-ui:check`, `npm run chat-ui:test`, and a clean `npm install` of the package from a git tag into a scratch app

## 12. In-flight window fix

- [x] 12.1 Claim the `AbortController` in `send()` before slice resolution so a send counts as in flight from the moment it is requested, not from the moment it is dispatched
- [x] 12.2 Honour a cancel that lands during resolution: finish the turn as cancelled and dispatch nothing
- [x] 12.3 Tests: streaming during resolution, second send refused, cancel before dispatch, a later send still works, and the panel locking its composer during resolution
- [x] 12.4 Confirm the tests fail against the pre-fix ordering
- [x] 12.5 Strip comments in the import-boundary guard so prose cannot trip a rule about code
