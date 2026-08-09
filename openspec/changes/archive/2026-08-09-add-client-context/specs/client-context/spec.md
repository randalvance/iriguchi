## ADDED Requirements

### Requirement: A request may carry a client context envelope
`POST /v1/chat/completions` SHALL accept an optional top-level `iri_context` field carrying a JSON object that describes the client's current surface. The envelope SHALL be scoped to the single request: the gateway SHALL NOT persist it, associate it with a session, or carry it into any subsequent request. An absent `iri_context` SHALL be equivalent to an empty object, and a request that omits it SHALL behave exactly as it does today.

#### Scenario: Context accepted alongside an agent
- **WHEN** a request sets `iri_agent` and an `iri_context` object
- **THEN** the run proceeds and the context is available to that run only

#### Scenario: Context accepted without an agent
- **WHEN** a vanilla request with no `iri_agent` supplies `iri_context`
- **THEN** the context is applied to the generic run rather than rejected

#### Scenario: Absent context changes nothing
- **WHEN** a request omits `iri_context`
- **THEN** the system prompt, tool set, and response are identical to those produced before this capability existed

#### Scenario: Context is not carried across requests
- **WHEN** one request supplies `iri_context` and a following request from the same client omits it
- **THEN** the second run sees no context

### Requirement: Context is validated for shape and size only
The gateway SHALL validate `iri_context` as a JSON object no larger than the configured maximum serialized byte length (`IRI_MAX_CONTEXT_BYTES`, default 65536), and SHALL NOT require or validate any particular key structure. A value that is present but not a JSON object — array, string, number, boolean, or `null` — SHALL be rejected with `400`, `type: "invalid_request_error"`, and `code: "invalid_context"`. A context exceeding the size limit SHALL be rejected with `400`, `type: "invalid_request_error"`, and `code: "context_too_large"`, with a message naming the limit and the observed size. A rejected request SHALL run no agent.

#### Scenario: Arbitrary keys accepted
- **WHEN** a context contains keys the gateway has never seen and no app has declared
- **THEN** it is accepted and made available to the run

#### Scenario: Non-object context rejected
- **WHEN** `iri_context` is an array, string, number, boolean, or `null`
- **THEN** the gateway returns `400` with `code: "invalid_context"` and runs no agent

#### Scenario: Oversized context rejected
- **WHEN** the serialized `iri_context` exceeds `IRI_MAX_CONTEXT_BYTES`
- **THEN** the gateway returns `400` with `code: "context_too_large"` and a message stating both the limit and the observed size

#### Scenario: Empty object is valid
- **WHEN** `iri_context` is `{}`
- **THEN** the request is accepted and treated as carrying no context

### Requirement: A context summary is injected into the system prompt
When a run carries a non-empty context, the gateway SHALL append a delimited context block to the agent's system prompt containing a summary of the context. The summary SHALL be produced by a deterministic walk of the context's top-level keys: scalar values SHALL render as `key: value` with each value truncated to 200 characters, and object or array values SHALL render as a shape placeholder naming the type and size rather than their contents. The block SHALL be capped at 2000 characters, and when the cap drops keys the block SHALL name the dropped keys. The block SHALL be appended last in the system prompt so the agent-derived prefix is unchanged across requests.

#### Scenario: Scalars are visible to the model
- **WHEN** a context supplies `route: "/accounts/acc_42"` and `account_id: "acc_42"`
- **THEN** both key/value pairs appear in the system prompt, so the model can answer "what was the total spending of this account last month" without the account being named in the prompt

#### Scenario: Nested payloads are summarized, not inlined
- **WHEN** a context supplies a `rows` array of 47 objects
- **THEN** the block renders a placeholder naming the type and the count, and no row content appears in the system prompt

#### Scenario: Same context yields the same block
- **WHEN** the same context object is supplied on two requests
- **THEN** the rendered block is byte-identical

#### Scenario: Truncation is announced
- **WHEN** the summary would exceed the 2000-character cap
- **THEN** the block is truncated and names the keys that were dropped

#### Scenario: Prefix stability
- **WHEN** two requests to the same agent supply different contexts
- **THEN** the portion of the system prompt preceding the context block is identical in both

### Requirement: Context is framed as untrusted data
The context block SHALL be introduced by a frame stating that it describes the user's current screen as supplied by the client application and is data rather than instructions. Occurrences of the block's delimiter within context keys or values SHALL be escaped so the block cannot be closed from within its own content.

#### Scenario: Instruction-shaped context is not obeyed as an instruction
- **WHEN** a context value contains text directing the model to ignore its system prompt
- **THEN** that text appears inside the framed data block rather than as a system instruction

#### Scenario: Delimiter injection is neutralized
- **WHEN** a context value contains the block's delimiter sequence
- **THEN** the occurrence is escaped and the block remains a single well-formed region

### Requirement: The full context is reachable through a get_context tool
When a run carries a non-empty context, the gateway SHALL expose a gateway-owned `get_context` tool to the model and SHALL permit its invocation. The tool SHALL accept one optional `path` argument in dot/bracket notation and SHALL return the value at that path, or the entire context when `path` is omitted. A `path` that resolves to nothing SHALL return an error payload naming the path rather than aborting the run. The tool SHALL NOT be exposed when the run carries no context.

#### Scenario: Model retrieves detail it was only shown a placeholder for
- **WHEN** the model calls `get_context` with `path: "rows"` on an import-preview context
- **THEN** it receives the full rows payload as a tool result

#### Scenario: Whole context returned by default
- **WHEN** the model calls `get_context` with no arguments
- **THEN** the entire context object is returned

#### Scenario: Unresolvable path is an error result, not a failure
- **WHEN** the model calls `get_context` with a path that is not present
- **THEN** it receives an error payload naming the path and the run continues

#### Scenario: Tool absent without context
- **WHEN** a run carries no context
- **THEN** no `get_context` tool is exposed to the model

### Requirement: Context values are excluded from logs
The gateway SHALL log the presence of a context by its top-level key names and its serialized byte size, and SHALL NOT log context values, at any log level.

#### Scenario: Values never reach the log
- **WHEN** a request supplies a context containing account identifiers and transaction rows
- **THEN** the emitted log records name the top-level keys and the byte size and contain none of the values

## Notes

`IRI_MAX_CONTEXT_BYTES` is a new gateway environment variable; it defaults to `65536` when unset.
