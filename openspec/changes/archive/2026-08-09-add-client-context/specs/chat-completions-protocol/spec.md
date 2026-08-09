## ADDED Requirements

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
