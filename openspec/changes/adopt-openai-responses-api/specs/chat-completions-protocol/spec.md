# chat-completions-protocol

## ADDED Requirements

### Requirement: Chat completions is an adapter over the Responses loop
`POST /v1/chat/completions` SHALL be implemented as an adapter over the same agent loop that serves `POST /v1/responses`, rather than as an independent execution path. It SHALL translate its `messages` array into Responses input items on the way in, and translate the run's output back into `chat.completion` / `chat.completion.chunk` shapes on the way out. All externally-observable behavior required elsewhere in this capability — `stream` negotiation, the aggregated non-streaming body, tool-call visibility, and JSON errors in both modes — SHALL be preserved exactly, so existing clients require no change.

#### Scenario: Existing clients are unaffected
- **WHEN** a client sends a request that worked before the transport change
- **THEN** it receives a response of the same shape, with the same status codes and headers

#### Scenario: Both surfaces agree on content
- **WHEN** the same agent and input are sent to `/v1/chat/completions` and to `/v1/responses`
- **THEN** the assistant text produced by each is the same for the same run

#### Scenario: Turn-limited runs still map to length
- **WHEN** a run reaches the configured maximum turns
- **THEN** the chat-completions surface reports `finish_reason: "length"`, as it did previously

#### Scenario: Tool visibility flag still honored
- **WHEN** `iri_show_tool_calls=true` is set on a chat-completions request
- **THEN** the run's tool invocations appear as `tool_calls`, translated from the loop's function calls

#### Scenario: Streaming framing unchanged
- **WHEN** a `stream: true` chat-completions request runs
- **THEN** the response is `chat.completion.chunk` SSE terminated by `data: [DONE]`, not Responses events
