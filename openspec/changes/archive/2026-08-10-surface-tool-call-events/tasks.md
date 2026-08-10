## 1. Gateway: body-driven flag

- [x] 1.1 In `src/routes/openai.ts`, resolve `showToolCalls` from the body's `iri_show_tool_calls` boolean, falling back to the `iri_show_tool_calls=true` query parameter when the body field is absent or not a boolean; do not reject non-boolean values
- [x] 1.2 Apply the same resolution in `src/routes/internal.ts:153`, factored so both routes share one helper rather than duplicating the precedence rule
- [x] 1.3 Add integration coverage in `tests/integration/chat.test.ts`: body-true works, body-false beats query-true, non-boolean body falls through to the query param without a 400
- [x] 1.4 Confirm the existing query-param callers still pass unchanged (`tests/integration/context-run.test.ts:431`, `tests/integration/agent-tool-loop.test.ts:121`)

## 2. Gateway: tool result events

- [x] 2.1 In `src/agent/runner.ts` `adaptSdkStream`, populate `is_error: block.is_error === true` on the yielded `tool_result` event
- [x] 2.2 In `src/agent/openai-sse.ts` `translateSdkEvent`, replace the `tool_result` no-op with a chunk carrying `delta.iri_tool_result = { id, is_error }`, gated on `ctx.showToolCalls`; comment that the id is the SDK's `tool_use_id` and that pairing is by id, never by position
- [x] 2.3 Extend the chunk/delta types so `iri_tool_result` is typed rather than cast at the emission site
- [x] 2.4 Unit tests in `tests/unit/openai-sse.test.ts`: result chunk emitted with `showToolCalls: true`, id matches the preceding `tool_calls` entry, `is_error` true for a failed tool, and nothing emitted with `showToolCalls: false`
- [x] 2.5 Unit test asserting `aggregateChunks` produces identical output for a sequence with and without `iri_tool_result` chunks interleaved
- [x] 2.6 Test asserting the flag-off stream for a tool-invoking run is byte-identical to today's output — the compatibility guarantee

## 3. chat-ui: transport

- [x] 3.1 Add `showToolCalls?: boolean` to `StreamRequest` and set `iri_show_tool_calls` in `buildRequestBody` only when true
- [x] 3.2 Extend `StreamHandlers` with optional `onToolCall({ id?, name, arguments })` and `onToolResult({ id?, is_error })`
- [x] 3.3 Parse both in `drain()`, defensively — skip malformed entries, wrap handler invocations so a throwing handler cannot abort the stream
- [x] 3.4 Transport tests: events fire in stream order; absent handlers are harmless; malformed `tool_calls` / `iri_tool_result` are skipped; a throwing handler leaves later deltas applied; the body omits the key when the flag is off

## 4. chat-ui: chat core and React surface

- [x] 4.1 Thread `showToolCalls` through `ChatOptions` into the `streamChatCompletion` call in `core/chat.ts`
- [x] 4.2 Add a tool-event subscriber set to the `Chat` object (plain `Set`, like `subscribe`) and dispatch call/result events into it from the transport handlers
- [x] 4.3 Expose `showToolCalls` on `IriguchiChatProviderProps` with a doc comment stating it is effectively mount-time, because the provider memoizes on `[endpoint, agent]`
- [x] 4.4 Add `useIriToolEvents(handler)` in `react/index.ts` using the ref-stable pattern from `useIriContext`, and export it plus the tool event types from the package entry points
- [x] 4.5 React tests: a nested consumer receives call then result; unmount unsubscribes; a new closure per render does not churn the registration; two sibling consumers both receive every event

## 5. Verification and release

- [x] 5.1 Run `npm test` and `npx tsc --noEmit` for the gateway, and `npm run chat-ui:check` / `npm run chat-ui:test` for the package
- [x] 5.2 Update the chat-ui README with the `showToolCalls` option and a `useIriToolEvents` example, stating that no tool payload is on the wire
- [x] 5.3a Bump `@iriguchi/chat-ui` to `0.2.0` and build the tarball (`npm run chat-ui:pack`)
- [x] 5.3b Publish `iriguchi-chat-ui-0.2.0.tgz` as a release asset (chat-ui-v0.2.0)
- [x] 5.4 Note for finance-app: bump the pinned `iriguchi-chat-ui-0.1.0.tgz` URL to `0.2.0`
