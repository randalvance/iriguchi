# responses-api-surface

## ADDED Requirements

### Requirement: Responses endpoint accepts the OpenAI Responses request shape
The gateway SHALL expose `POST /v1/responses`, authenticated by the same client bearer token as the rest of the OpenAI-compatible surface. It SHALL accept `model`, `input` as either a string or an array of typed input items, `instructions`, `tools`, `stream`, `max_output_tokens`, and the gateway extension `iri_agent`. A string `input` SHALL be treated as a single user message. Requests whose `input` is absent, or is neither a string nor an array of well-formed items, SHALL be rejected with `400` and `type: "invalid_request_error"` before any provider call is made.

#### Scenario: String input accepted
- **WHEN** a request supplies `input` as a plain string
- **THEN** the run proceeds with that string as a single user message

#### Scenario: Item array input accepted
- **WHEN** a request supplies `input` as an array of role/content items
- **THEN** the run proceeds with those items in order

#### Scenario: Missing input rejected
- **WHEN** a request omits `input`
- **THEN** the gateway returns `400` with `type: "invalid_request_error"` naming the field, and no provider call is made

#### Scenario: Malformed items rejected
- **WHEN** `input` is an array containing an element that is not a well-formed item
- **THEN** the gateway returns `400` and no provider call is made

### Requirement: The endpoint is stateless
The gateway SHALL reject any request setting `store: true` or a non-null `previous_response_id` with `400`, and SHALL NOT persist responses or conversation state. Clients SHALL send the full input on every request. `store: false` and an absent `store` SHALL both be accepted.

#### Scenario: store true rejected
- **WHEN** a request sets `store: true`
- **THEN** the gateway returns `400` with a message stating the gateway is stateless

#### Scenario: previous_response_id rejected
- **WHEN** a request sets `previous_response_id` to a non-null value
- **THEN** the gateway returns `400` with a message stating the gateway is stateless

#### Scenario: store false accepted
- **WHEN** a request sets `store: false` or omits `store`
- **THEN** the request proceeds normally

#### Scenario: No response is retrievable afterwards
- **WHEN** a response has been returned
- **THEN** no gateway endpoint can retrieve it by id, and nothing about it is written to the store

### Requirement: Non-streaming responses return a response object
A non-streaming request SHALL return a single JSON object with `object: "response"`, an `id`, `created_at`, `model`, `status: "completed"`, and an `output` array of typed items. Assistant text SHALL appear as a `message` item whose `content` contains an `output_text` part carrying the concatenated text of the run. When tool-call visibility is requested, the `function_call` items the run performed SHALL appear in `output` in invocation order. The response SHALL carry the same `X-Request-Id` header the rest of the surface uses.

#### Scenario: Text output item present
- **WHEN** a non-streaming run produces assistant text
- **THEN** `output` contains a `message` item whose `output_text` part equals the concatenation of the run's text, in order

#### Scenario: Terminal status reported
- **WHEN** a run completes normally
- **THEN** `status` is `"completed"`

#### Scenario: Turn-bounded run reported as incomplete
- **WHEN** a run terminates because it reached the configured maximum turns
- **THEN** `status` is `"incomplete"` and the response records that reason rather than claiming completion

#### Scenario: Empty run yields an empty text part
- **WHEN** a run produces no text
- **THEN** the `output_text` part is the empty string rather than absent or null

### Requirement: Streaming emits typed Responses events
A request setting `stream: true` SHALL return `text/event-stream` carrying typed Responses events, beginning with `response.created`, carrying incremental assistant text as `response.output_text.delta`, and ending with `response.completed`. Each event SHALL be emitted as an SSE `data:` payload containing the event object. The stream SHALL NOT emit `chat.completion.chunk` objects, and the `[DONE]` sentinel of the chat-completions surface SHALL NOT be used to terminate it.

#### Scenario: Stream opens and closes with lifecycle events
- **WHEN** a streaming request runs to completion
- **THEN** the first event is `response.created` and the last is `response.completed`

#### Scenario: Text arrives as deltas
- **WHEN** the run produces assistant text incrementally
- **THEN** the client receives `response.output_text.delta` events whose concatenated text equals the non-streaming `output_text` for the same run

#### Scenario: Absent stream defaults to non-streaming
- **WHEN** a request omits `stream`
- **THEN** the gateway returns the single JSON `response` object rather than an event stream

#### Scenario: Non-boolean stream rejected
- **WHEN** `stream` is present and not a boolean
- **THEN** the gateway returns `400` and starts no run

### Requirement: Agent selection and errors match the existing surface
`iri_agent` SHALL select a registered agent exactly as it does on the chat-completions surface, and an unknown agent SHALL be rejected with the same `404` and `code: "unknown_agent"`. Errors raised before any output is committed SHALL be returned as JSON with the appropriate status in both streaming and non-streaming modes.

#### Scenario: Unknown agent rejected identically
- **WHEN** a Responses request names an unknown `iri_agent`
- **THEN** the gateway returns `404` with `code: "unknown_agent"` as JSON

#### Scenario: Vanilla request uses the default provider
- **WHEN** a Responses request omits `iri_agent`
- **THEN** the run executes against the default provider with the gateway's generic instructions

#### Scenario: Pre-commit errors are JSON in streaming mode
- **WHEN** a `stream: true` request fails before any event is written
- **THEN** the gateway returns a JSON error with a non-2xx status rather than an event stream
