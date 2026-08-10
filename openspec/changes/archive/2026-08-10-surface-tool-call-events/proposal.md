## Why

finance-app is adding a write tool (`finance__apply_preview_categories`) to its MCP server: the user opens the Ask AI panel on an import preview page, says "categorize these rows", and the agent mutates the draft server-side. The page has no way to learn that the write landed — it must refetch **when the tool finishes**, not when the model stops talking, or a long run over a 400-row statement sits frozen and then jumps.

Today the gateway drops `tool_result` events entirely, and `iri_show_tool_calls` is a query parameter that the chat-ui proxy discards — so a browser cannot turn tool visibility on at all. This change blocks finance-app's chat-driven import categorization.

## What Changes

- Accept `iri_show_tool_calls: boolean` in the `/v1/chat/completions` request body (both the public and internal routes), with the existing query parameter kept as a fallback and the body winning when both are present. The chat-ui proxy stays "deliberately dumb" and keeps parsing nothing.
- Emit a stream chunk for each `tool_result`, carrying `delta.iri_tool_result = { id?, is_error }` — a completion signal only, never the tool's return payload. Gated on the same `showToolCalls` flag as `tool_calls`.
- Populate `is_error` on the runner's `tool_result` events from the SDK block, which it currently drops.
- chat-ui: extend `StreamHandlers` with optional `onToolCall` / `onToolResult`, parsed defensively in `drain()`; add `showToolCalls` to `StreamRequest` / `ChatOptions` / `IriguchiChatProviderProps`, omitted from the wire when false.
- chat-ui: add a `useIriToolEvents(handler)` subscription hook, registered through the same ref-stable pattern as `useIriContext`, so a page one level deep in the tree can observe tool activity without the app root knowing it exists.
- Cut `@iriguchi/chat-ui` `0.2.0` and publish a release tarball; finance-app pins by URL.
- Not breaking: a run with `iri_show_tool_calls` unset produces a byte-identical stream to today, and that invariant is asserted.

## Capabilities

### New Capabilities

None. Both surfaces already have specs.

### Modified Capabilities

- `chat-completions-protocol`: tool visibility becomes body-driven with query fallback; the stream gains a tool-result completion event under that flag; non-streaming aggregation is unchanged by the new chunk.
- `chat-ui-client`: the client can request tool visibility, parse tool-call and tool-result events, and expose them to React consumers through a subscription hook.

## Impact

- Gateway: `src/routes/openai.ts`, `src/routes/internal.ts`, `src/agent/openai-sse.ts`, `src/agent/runner.ts`.
- Gateway tests: `tests/unit/openai-sse.test.ts`, `tests/integration/chat.test.ts`; existing query-param callers in `tests/integration/context-run.test.ts` and `tests/integration/agent-tool-loop.test.ts` keep working unchanged.
- Client: `packages/chat-ui/src/core/transport.ts`, `core/chat.ts`, `core/types.ts`, `react/index.ts`, plus package version and README.
- Downstream: finance-app bumps its `iriguchi-chat-ui` tarball URL to `0.2.0`.
- Out of scope: tool result payloads on the wire, any rendering of tool activity in the panel UI, and replay of tool events across a reconnect.
