## Context

Verified against the code, not assumed:

- `src/agent/openai-sse.ts:88` — `translateSdkEvent` turns an SDK `tool_use` into an OpenAI-shaped `choices[0].delta.tool_calls` chunk, gated on `ctx.showToolCalls`.
- `src/agent/openai-sse.ts:107` — `tool_result` returns `[]` with a comment saying clients see only the model's next text turn. This is the behaviour that changes.
- `src/routes/openai.ts:77` and `src/routes/internal.ts:153` — `showToolCalls` is read from `c.req.query("iri_show_tool_calls") === "true"`.
- `src/agent/runner.ts:347-355` — `adaptSdkStream` yields `{ type: "tool_use", id: block.id, ... }` from assistant blocks and `{ type: "tool_result", id: block.tool_use_id, result: block.content }` from user blocks. `is_error` is declared on `SdkEvent` but never populated.
- `packages/chat-ui/src/core/transport.ts:129` — `drain()` reads only `choices[0].delta.content`; every other field is ignored by design, so adding fields is safe for existing clients.
- `packages/chat-ui/src/server/index.ts:44` — the proxy builds `gatewayUrl + (path ?? "/v1/chat/completions")` and discards the incoming query string. A browser therefore cannot set `iri_show_tool_calls` today.
- `packages/chat-ui/src/core/types.ts` — `Registration` carries a `kind` discriminant so non-context registrations can be added without disturbing context slices.
- `packages/chat-ui/src/react/index.ts:26` — `IriguchiChatProvider` memoizes the chat on `[endpoint, agent]` only.

The consumer is finance-app: an import-preview page that must refetch its draft the moment a write tool finishes, mid-run.

## Goals / Non-Goals

**Goals:**

- A browser client can turn tool visibility on through the JSON body it already builds.
- Per tool invocation, a client observes exactly one call event and one completion event, in order, pairable to each other.
- Zero wire change for anyone who does not ask for it.
- The non-streaming aggregation path is provably unaffected.

**Non-Goals:**

- Tool result payloads on the wire.
- Any rendering of tool activity inside the panel UI.
- Replay of tool events across a reconnect — the chat resends the whole conversation each turn; there is no session to resume.
- Touching the proxy's URL handling.

## Decisions

### The flag moves into the body; the query param stays as a fallback

Every other control on this API (`iri_agent`, `iri_context`, `stream`, `model`) travels in the JSON body. `iri_show_tool_calls` as a query parameter is the odd one out, and it is the one the proxy drops. Both routes resolve:

```ts
const showToolCalls =
  typeof body.iri_show_tool_calls === "boolean"
    ? body.iri_show_tool_calls
    : c.req.query("iri_show_tool_calls") === "true";
```

Body wins when both are present. A non-boolean `iri_show_tool_calls` falls through to the query param rather than 400-ing: this is a display hint, and rejecting a run over it is a worse outcome than ignoring it. (Contrast `stream`, which selects the response mode and is validated.)

*Alternative rejected:* teach the proxy to forward the query string. That makes the proxy parse and re-emit request URLs — it currently parses nothing, which is why it has no attack surface — for a control that belongs in the body anyway.

### Tool results ride an extension field on the delta

```ts
delta: { iri_tool_result: { id?: string; is_error: boolean } }
```

Not a top-level chunk field: the OpenAI chunk shape has no slot for it, and `delta` is where per-event data already lives, so existing parsers walk past it the same way they walk past `tool_calls`. The `iri_` prefix marks it as a gateway extension, matching `iri_agent` / `iri_context`.

The tool's return payload stays off the wire. The page only needs to know the call finished; payloads can be large, and shipping them to a browser widens what the stream exposes for no gain here.

One flag gates both events. A client asking to see tool calls is asking to see the tool loop; splitting this into two switches buys nothing and doubles the matrix.

### Correlation is by id, and the ids are real

The SDK's own content blocks carry them: `block.id` on `tool_use` and `block.tool_use_id` on `tool_result` (`src/agent/runner.ts:348,354`) are the Anthropic Messages API's own correlation ids, always present on a well-formed block. `SdkEvent` declares both as optional only because the type is hand-written and defensive. So: pair on id, with a comment at the emission site saying where the id comes from.

The fallback is stated rather than built: if an id is ever absent, that event is not pairable, and the client's handler receives `id: undefined`. No positional pairing and no synthesized ids — positional pairing is silently wrong under parallel tool calls, which is exactly the case a mutating tool is likely to hit.

### `is_error` gets populated at the runner

`adaptSdkStream` currently drops it. It becomes `is_error: block.is_error === true`, normalized to a boolean at the runner so the translate layer never emits `undefined`. A failed write must not read as a successful one on the client.

### `aggregateChunks` is untouched

It iterates `choice.delta.content` and `choice.delta.tool_calls` and ignores everything else, so result chunks pass through it invisibly. That is asserted with a test rather than left to inspection, because "provably derived from the same event sequence" is a stated invariant of that function.

### The client surfaces events through a subscription hook

`useIriToolEvents(handler)` registers against the chat, using the same ref-stable pattern as `useIriContext` — the handler is read through a ref so a new closure per render does not churn the registration; only mount and unmount do.

*Alternative rejected:* `onToolCall` / `onToolResult` callbacks on the provider. There is one provider mounted for the whole app in the host, so a page-level consumer would have to route through the app root. The consumer here is one page deep and mounts and unmounts with the route.

The subscriber list lives on the `Chat` object (a plain `Set`, like `subscribe`), not in the `SliceRegistry` — registry entries are context slices resolved at send time, and tool subscribers have neither a key nor a value. The `Registration.kind` discriminant stays available for a future client-executed-action registration; nothing here needs it.

### `showToolCalls` is a mount-time option

It threads `StreamRequest` → `ChatOptions` → `IriguchiChatProviderProps`. Because the provider memoizes on `[endpoint, agent]`, changing it after mount does not rebuild the chat — correct, since rebuilding drops the conversation, but it means the flag is effectively fixed at mount. A doc comment says so.

When false or absent, `buildRequestBody` omits the key entirely, so the wire shape is byte-identical for every existing consumer.

Parsing in `drain()` is defensive in the same spirit as the existing code: a `tool_calls` entry that is not an object, or lacks a string `function.name`, is skipped rather than thrown; a malformed `iri_tool_result` is skipped. A handler that throws must not kill the stream — handler invocations are wrapped.

## Risks / Trade-offs

- **A tool result arrives before the client has seen its call event** (out-of-order delivery, or a dropped call chunk) → the events are emitted in the runner's own order over a single ordered SSE stream, so this cannot happen in transit; a client that receives a result for an unknown id should treat it as "something finished" rather than error.
- **`is_error` is the only failure signal, with no message** → deliberate. A page refetching a draft needs to know the write failed, not why; the model's text turn carries the why.
- **Parallel tool calls make "which tool finished" ambiguous for clients that ignore ids** → mitigated by shipping ids and documenting that pairing is by id, not position.
- **Consumers may start treating the tool stream as an API** → the extension field is namespaced `iri_` and documented as a completion signal only, with no payload, which limits what can be built on it.
- **A slow or throwing consumer handler stalls the drain loop** → handler calls are wrapped in try/catch; a throwing handler is ignored for that event. Handlers are expected to be cheap (kick off a refetch), and the client does not await them.

## Migration Plan

1. Gateway ships first; existing query-param callers and the two integration tests that use them keep passing unchanged.
2. `@iriguchi/chat-ui` `0.2.0` is cut and a release tarball published.
3. finance-app bumps its tarball URL and opts in with `showToolCalls`.

No rollback coupling: an old client against a new gateway sees no change (it never sets the flag), and a new client against an old gateway sets a body field the old gateway ignores, so it simply observes no tool events.

## Open Questions

None blocking. If the SDK is ever observed emitting a `tool_result` without `tool_use_id`, revisit whether the runner should synthesize a correlation id — but do not build for it before it is seen.
