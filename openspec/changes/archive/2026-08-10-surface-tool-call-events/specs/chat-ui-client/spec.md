## ADDED Requirements

### Requirement: The client can request tool visibility
The client SHALL accept a `showToolCalls` option, threaded from the React provider through the chat to the transport. When it is `true`, the request body SHALL carry `iri_show_tool_calls: true`. When it is `false` or absent, the key SHALL be omitted from the request body entirely, leaving the wire shape unchanged for consumers that do not use this feature. The option SHALL NOT be sent on the query string, and the server proxy SHALL continue to forward request bodies without parsing them.

Because the provider rebuilds its chat only when `endpoint` or `agent` change, `showToolCalls` SHALL take effect at mount and a later change to it SHALL NOT rebuild the chat or drop the conversation. This SHALL be stated in the option's documentation.

#### Scenario: Flag set reaches the wire
- **WHEN** a host mounts the provider with `showToolCalls` true and a message is sent
- **THEN** the request body contains `iri_show_tool_calls: true`

#### Scenario: Default wire shape is unchanged
- **WHEN** a host does not set `showToolCalls` and a message is sent
- **THEN** the request body contains no `iri_show_tool_calls` key and is otherwise identical to the body sent before this capability existed

#### Scenario: Proxy still parses nothing
- **WHEN** a request carrying `iri_show_tool_calls` passes through the server proxy
- **THEN** the proxy forwards the body unmodified and reads no field from it

### Requirement: The transport reports tool calls and completions
The transport's stream handlers SHALL accept optional `onToolCall` and `onToolResult` callbacks alongside `onDelta`. `onToolCall` SHALL be invoked once per `tool_calls` entry observed in the stream, receiving the call's optional `id`, its `name`, and its `arguments` string. `onToolResult` SHALL be invoked once per `iri_tool_result` observed, receiving the result's optional `id` and its `is_error` boolean. Callbacks SHALL fire in stream order, so a call is always reported before its own completion.

Parsing SHALL be defensive, matching how the transport already treats unrecognized chunks: a malformed or non-conforming `tool_calls` entry or `iri_tool_result` value SHALL be skipped rather than raised, and a callback that throws SHALL NOT abort the stream or the run.

#### Scenario: Call and completion are both reported
- **WHEN** a stream carries a `tool_calls` chunk followed by an `iri_tool_result` chunk for the same id
- **THEN** `onToolCall` fires first with that name and arguments, then `onToolResult` fires with the same id

#### Scenario: Absent handlers are harmless
- **WHEN** a stream carries tool chunks and the caller supplied only `onDelta`
- **THEN** the text deltas are applied as usual and no error is raised

#### Scenario: Malformed entries are skipped
- **WHEN** a chunk carries a `tool_calls` entry that is not an object, or lacks a tool name, or an `iri_tool_result` that is not an object
- **THEN** that entry is ignored, no callback fires for it, and the rest of the stream is processed normally

#### Scenario: A throwing handler does not break the run
- **WHEN** a consumer's tool-event handler throws
- **THEN** the stream continues, later deltas are still applied, and the turn completes normally

### Requirement: React consumers subscribe to tool events by hook
The client SHALL expose a `useIriToolEvents` hook that registers a handler for the chat's tool events and unregisters it when the consuming component unmounts. The hook SHALL read the handler through a ref, so a new closure on each render does not churn the registration and only mount and unmount change it. Registration SHALL NOT require the consuming component to be anything other than a descendant of the provider, and SHALL NOT require the host's app root to know the consumer exists.

Multiple mounted consumers SHALL each receive every event.

#### Scenario: A page-level consumer receives events
- **WHEN** a component nested under the provider registers a handler and a run invokes a tool
- **THEN** the handler receives the tool call event and then the tool result event

#### Scenario: Unmounting unsubscribes
- **WHEN** the registering component unmounts and a later run invokes a tool
- **THEN** its handler is not invoked

#### Scenario: Re-rendering does not churn the registration
- **WHEN** the consuming component re-renders with a newly created handler closure
- **THEN** the registration is not replaced and the most recent closure receives subsequent events

#### Scenario: Siblings both observe
- **WHEN** two mounted components each register a handler
- **THEN** both handlers receive every tool call and tool result event
