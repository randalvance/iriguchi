# chat-completions-protocol

## ADDED Requirements

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
When `iri_show_tool_calls=true` is set on the query string, a non-streaming response SHALL include the run's tool invocations as `choices[0].message.tool_calls`, each with the `id`, `type: "function"`, and `function.name` / `function.arguments` that streaming mode would have emitted as deltas, in invocation order. When the flag is absent or not `true`, `tool_calls` SHALL be omitted.

#### Scenario: Tool calls surfaced when requested
- **WHEN** a non-streaming request sets `iri_show_tool_calls=true` and the agent invokes two tools
- **THEN** `choices[0].message.tool_calls` has two entries in invocation order with their names and JSON-encoded arguments

#### Scenario: Tool calls hidden by default
- **WHEN** a non-streaming request omits `iri_show_tool_calls`
- **THEN** the response has no `tool_calls` field

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
