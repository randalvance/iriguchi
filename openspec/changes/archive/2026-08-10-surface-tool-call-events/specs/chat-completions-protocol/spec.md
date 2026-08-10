## MODIFIED Requirements

### Requirement: Tool call visibility is honored in both modes
Tool call visibility SHALL be requested either by the request body's `iri_show_tool_calls` boolean or by the `iri_show_tool_calls=true` query parameter, with the body taking precedence when both are present and the query parameter serving as a fallback when the body field is absent or not a boolean. An `iri_show_tool_calls` body value that is not a boolean SHALL NOT fail the request, since the field is a display hint rather than a mode selector.

When tool call visibility is on, a non-streaming response SHALL include the run's tool invocations as `choices[0].message.tool_calls`, each with the `id`, `type: "function"`, and `function.name` / `function.arguments` that streaming mode would have emitted as deltas, in invocation order. When it is off, `tool_calls` SHALL be omitted.

#### Scenario: Tool calls surfaced when requested
- **WHEN** a non-streaming request sets `iri_show_tool_calls=true` and the agent invokes two tools
- **THEN** `choices[0].message.tool_calls` has two entries in invocation order with their names and JSON-encoded arguments

#### Scenario: Tool calls hidden by default
- **WHEN** a non-streaming request omits `iri_show_tool_calls`
- **THEN** the response has no `tool_calls` field

#### Scenario: Body field turns visibility on
- **WHEN** a request body sets `iri_show_tool_calls: true` and no query parameter is present
- **THEN** tool calls are surfaced exactly as the query parameter form surfaces them

#### Scenario: Body wins over query parameter
- **WHEN** a request sets `iri_show_tool_calls=true` on the query string and `iri_show_tool_calls: false` in the body
- **THEN** no tool calls are surfaced

#### Scenario: Non-boolean body value falls back to the query parameter
- **WHEN** a request body sets `iri_show_tool_calls` to a string and the query string sets `iri_show_tool_calls=true`
- **THEN** the run proceeds, is not rejected, and tool calls are surfaced

## ADDED Requirements

### Requirement: Streaming responses report tool completion
When tool call visibility is on, a streaming response SHALL emit one chunk per completed tool invocation carrying `choices[0].delta.iri_tool_result`, an object with the invocation's correlation `id` and an `is_error` boolean. The `id` SHALL be the same identifier carried by that invocation's `tool_calls` entry, so a client can pair a completion with the call that produced it. `is_error` SHALL be `true` when the tool reported a failure and `false` otherwise, and SHALL always be present as a boolean.

The chunk SHALL be emitted in the run's own event order, after the chunk announcing the corresponding call. It SHALL NOT carry the tool's return payload in any form.

When tool call visibility is off, no such chunk SHALL be emitted, and the stream SHALL be byte-identical to the stream the same run produced before this capability existed.

#### Scenario: Completion follows its call
- **WHEN** a streaming run with tool visibility on invokes one tool that succeeds
- **THEN** the stream carries one `tool_calls` chunk followed by one `iri_tool_result` chunk whose `id` matches that call's `id`, and whose `is_error` is `false`

#### Scenario: Failed tool is reported as an error
- **WHEN** a tool invocation returns an error result
- **THEN** the corresponding `iri_tool_result` chunk has `is_error: true`

#### Scenario: Payload never reaches the wire
- **WHEN** a tool returns a large result body
- **THEN** no part of that body appears anywhere in the streamed response's chunks

#### Scenario: Parallel invocations remain pairable
- **WHEN** a run invokes two tools and both complete
- **THEN** the stream carries two `iri_tool_result` chunks whose `id`s match the two `tool_calls` entries, in the order the tools completed

#### Scenario: Off by default, byte-identical stream
- **WHEN** a streaming run invokes tools without tool call visibility requested
- **THEN** the stream contains no `iri_tool_result` chunk and is byte-identical to the stream produced for the same event sequence before this change

### Requirement: Non-streaming aggregation ignores tool result chunks
The aggregation that collapses a run's chunks into a single `chat.completion` SHALL be unaffected by the presence of `iri_tool_result` chunks: its `content`, `tool_calls`, and `finish_reason` SHALL be identical whether or not those chunks are present in the event sequence.

#### Scenario: Aggregate is unchanged by result chunks
- **WHEN** the same chunk sequence is aggregated with and without `iri_tool_result` chunks interleaved
- **THEN** both aggregations produce identical `chat.completion` objects
