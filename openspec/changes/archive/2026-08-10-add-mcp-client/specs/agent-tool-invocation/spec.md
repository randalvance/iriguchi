## ADDED Requirements

### Requirement: Discovered MCP tools are reachable during a run
An agent whose manifest declares an `mcp` server SHALL have that server's discovered tools exposed to the model for the duration of a run, and a tool the model elects to call SHALL result in a `tools/call` request to the declared server carrying the model-generated arguments and any `headers` declared on the entry. The server prefix SHALL be stripped from the exposed name before the call, so the server receives the tool's own name. As with `api_call` tools, exposure SHALL be independent of which configured provider the agent is routed to.

#### Scenario: Model-elected MCP tool reaches the server
- **WHEN** an agent declaring an MCP server is run and the model emits a call for `finance__list_accounts`
- **THEN** the server receives a `tools/call` request naming `list_accounts` with the model-generated arguments

#### Scenario: Declared headers are presented
- **WHEN** an `mcp` entry declares `headers` and one of its tools is called
- **THEN** the request to the server carries those headers

#### Scenario: MCP tool exposure is provider-independent
- **WHEN** the same agent is routed to a different configured provider
- **THEN** its discovered MCP tools are exposed identically, with no provider-specific gating

#### Scenario: Agent with no mcp entries contacts no server
- **WHEN** an agent declares only `api_call` tools
- **THEN** no MCP connection is opened during the run

### Requirement: MCP failures map onto the existing tool-result error contract
The three distinct MCP failure modes SHALL be folded into the same result shape `api_call` tools already produce, rather than a parallel one. A transport failure SHALL yield `{ error: { kind: "network" | "timeout", message } }` or, for a non-2xx HTTP response, `{ error: { status, body } }` — byte-identical to the `api_call` forms. A JSON-RPC error object SHALL yield `{ error: { kind: "mcp_protocol", code, message } }`. A tool result carrying `isError: true` SHALL yield `{ error: { kind: "mcp_tool_error", message } }` whose message preserves the server's own error text rather than substituting a generic one. A successful result's content SHALL be flattened to text and parsed as JSON when the text parses, else returned as raw text.

#### Scenario: Transport failure is indistinguishable from an api_call transport failure
- **WHEN** an MCP server refuses the connection
- **THEN** the model receives `{ error: { kind: "network", message } }`, the same shape an unreachable app endpoint produces

#### Scenario: Timeout is bounded by the declared timeout
- **WHEN** a `tools/call` exceeds the entry's `timeout_ms`
- **THEN** the model receives `{ error: { kind: "timeout", message } }` naming the elapsed bound

#### Scenario: JSON-RPC error is classified distinctly
- **WHEN** the server answers with a JSON-RPC error object
- **THEN** the model receives `{ error: { kind: "mcp_protocol", code, message } }` carrying the server's code

#### Scenario: Tool error preserves the server's message
- **WHEN** a tool returns a result with `isError: true` and text describing a failed database query
- **THEN** the model receives `{ error: { kind: "mcp_tool_error", message } }` containing that text verbatim

#### Scenario: Successful JSON content is returned parsed
- **WHEN** a tool returns a text content block whose body is valid JSON
- **THEN** the model receives the parsed value, not a JSON-encoded string

### Requirement: Transport failures retry once; tool errors do not
An MCP `tools/call` that fails at the transport level — network error, timeout, or non-2xx HTTP — SHALL be retried once after a short delay, mirroring the existing `api_call` retry. A result carrying `isError: true` SHALL NOT be retried, because the gateway cannot know a tool is idempotent; the error SHALL be handed to the model, which may elect to call again.

#### Scenario: Transient transport failure recovers
- **WHEN** the first `tools/call` fails with a network error and the second succeeds
- **THEN** the model receives the successful result and the run continues normally

#### Scenario: isError result is not retried
- **WHEN** a tool returns `isError: true`
- **THEN** exactly one `tools/call` is issued and the error payload reaches the model

## MODIFIED Requirements

### Requirement: Tool results are folded back into the run
A tool's response SHALL be returned to the model as the result of its call, and the model's subsequent output SHALL be able to incorporate it. A tool that fails SHALL yield an error payload to the model rather than aborting the run, so the model can react to it. This SHALL hold for both tool types: for `api_call` tools, failure means non-2xx, timeout, or network error; for MCP tools, it additionally covers JSON-RPC error responses and tool results carrying `isError: true`. The final assistant text SHALL reflect the completed multi-turn exchange, not just the turn that requested the tool.

#### Scenario: Result reaches the model's next turn
- **WHEN** an agent calls a tool that returns data, and the model then produces text derived from it
- **THEN** the run's final assistant content contains that derived text

#### Scenario: Failing tool does not abort the run
- **WHEN** a declared tool endpoint returns a non-2xx response
- **THEN** the model receives an error payload as the tool result and the run continues to completion

#### Scenario: Failing MCP tool does not abort the run
- **WHEN** a discovered MCP tool returns a result with `isError: true`
- **THEN** the model receives an error payload as the tool result and the run continues to completion

### Requirement: End-to-end tool invocation is verified without live credentials
The test suite SHALL include provider-agnostic tests that exercise the full tool loop — declaration, model-elected call, downstream request, result, and final answer — against a scripted provider, so they run in the default suite with no API key and no network. This SHALL cover both tool types: `api_call` tools against a scripted app, and MCP tools against a fake in-process MCP server. Coverage of either loop SHALL NOT depend solely on tests gated behind live-credential flags.

#### Scenario: Full loop runs in the default suite
- **WHEN** the default test suite is run with no provider credentials configured
- **THEN** a test exercising the complete `api_call` tool loop executes and passes rather than being skipped

#### Scenario: MCP loop runs in the default suite
- **WHEN** the default test suite is run with no provider credentials and no reachable MCP server
- **THEN** a test exercising discovery, model-elected call, `tools/call`, result, and final answer against a fake MCP server executes and passes

#### Scenario: Failure is attributable
- **WHEN** the tool loop breaks
- **THEN** the failing assertion identifies which stage broke — tool exposure, discovery, downstream request, result hand-back, or final answer
