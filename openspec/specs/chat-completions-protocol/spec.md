# chat-completions-protocol Specification

## Purpose
TBD - created by archiving change fix-app-integration-handshake. Update Purpose after archive.
## Requirements
### Requirement: Response mode is negotiated by the `stream` field
`POST /v1/chat/completions` SHALL select its response mode from the request body's `stream` field. `stream: true` SHALL produce an OpenAI-style `text/event-stream` response terminated by `data: [DONE]`. `stream: false`, and an absent `stream` field, SHALL produce a single `application/json` `chat.completion` object. A `stream` value that is present but not a boolean SHALL be rejected with `400` and `type: "invalid_request_error"`.

#### Scenario: Explicit streaming request
- **WHEN** a request body sets `stream: true`
- **THEN** the response has `Content-Type: text/event-stream` and emits `chat.completion.chunk` events followed by `data: [DONE]`

#### Scenario: Explicit non-streaming request
- **WHEN** a request body sets `stream: false`
- **THEN** the response has `Content-Type: application/json` and its body parses as a single `chat.completion` object

#### Scenario: Absent stream field defaults to non-streaming
- **WHEN** a request body omits `stream`
- **THEN** the response is the same single `chat.completion` JSON object as `stream: false`, matching the OpenAI protocol default

#### Scenario: Non-boolean stream rejected
- **WHEN** a request body sets `stream` to a string, number, or object
- **THEN** the gateway returns `400` with `type: "invalid_request_error"` and a message naming the `stream` field, and runs no agent

### Requirement: Non-streaming responses aggregate the agent run
A non-streaming response body SHALL be a `chat.completion` object carrying the same `id`, `created`, and `model` the streaming mode would have used, with `object: "chat.completion"` and a single `choices[0]` whose `message` has `role: "assistant"` and `content` equal to the concatenation, in order, of every text delta the run produced. `choices[0].finish_reason` SHALL be the terminal finish reason of the run (`"stop"`, or `"length"` when the run ended on max turns). The response SHALL carry the same `X-Request-Id` header as the streaming mode. The `data: [DONE]` sentinel SHALL NOT appear in a non-streaming body.

#### Scenario: Text deltas are concatenated in order
- **WHEN** an agent run emits several text chunks in a non-streaming request
- **THEN** `choices[0].message.content` is those chunks joined in emission order with no separators added

#### Scenario: Identity fields match streaming mode
- **WHEN** a non-streaming response is returned
- **THEN** its `id` has the `chatcmpl-` prefix, its `model` is the resolved model for the agent or request, and the `X-Request-Id` response header is present

#### Scenario: Max-turns run reports length
- **WHEN** a run terminates because the agent hit the configured max turns
- **THEN** `choices[0].finish_reason` is `"length"`

#### Scenario: Empty run yields empty content
- **WHEN** a run produces no text deltas
- **THEN** `choices[0].message.content` is the empty string rather than `null` or a missing field

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

### Requirement: Errors are JSON in both modes
Request validation failures and gateway errors raised before any output is committed SHALL be returned as a JSON error object with the appropriate HTTP status in both streaming and non-streaming modes, never as an SSE event. An error raised *after* a non-streaming run has begun SHALL still produce a JSON error response with the correct HTTP status, because no bytes have been committed to the client; the streaming mode's behavior of emitting a terminal error event mid-stream SHALL be unchanged.

#### Scenario: Unknown agent in non-streaming mode
- **WHEN** a non-streaming request names an unknown `iri_agent`
- **THEN** the gateway returns the existing `404` JSON error with `code: "unknown_agent"` and `Content-Type: application/json`

#### Scenario: Mid-run failure in non-streaming mode
- **WHEN** an agent run fails partway through a non-streaming request
- **THEN** the gateway returns a JSON error object with a non-2xx status and the `X-Request-Id` header, not a partial `chat.completion`

#### Scenario: Mid-stream failure keeps streaming behavior
- **WHEN** an agent run fails partway through a `stream: true` request
- **THEN** the gateway emits the error as an SSE event followed by `data: [DONE]`, as it does today

### Requirement: `iri_context` is an accepted request field in both response modes
`POST /v1/chat/completions` SHALL accept the optional `iri_context` field in both streaming and non-streaming modes, and its validation SHALL occur before any agent run begins. Because validation precedes the run, an invalid context SHALL always produce a JSON error object with `400` and `type: "invalid_request_error"` — never an SSE event — regardless of the request's `stream` value. The field SHALL NOT appear in the response body in either mode, and its presence SHALL NOT alter the `chat.completion` or `chat.completion.chunk` shapes.

#### Scenario: Invalid context rejected as JSON in streaming mode
- **WHEN** a request sets `stream: true` and an `iri_context` that is not a JSON object
- **THEN** the gateway returns a `400` JSON error with `Content-Type: application/json` and emits no SSE events

#### Scenario: Invalid context rejected as JSON in non-streaming mode
- **WHEN** a request sets `stream: false` and an oversized `iri_context`
- **THEN** the gateway returns a `400` JSON error with `code: "context_too_large"`

#### Scenario: Response shape is unchanged by context
- **WHEN** a valid `iri_context` is supplied
- **THEN** the response carries the same fields it would carry without it, and no echo of the context

#### Scenario: Unknown agent still outranks context validation failure semantics
- **WHEN** a request names an unknown `iri_agent` and also supplies a valid `iri_context`
- **THEN** the existing `404` `unknown_agent` error is returned unchanged

