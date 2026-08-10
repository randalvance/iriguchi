# agent-tool-invocation Specification

## Purpose
TBD - created by archiving change add-openrouter-provider. Update Purpose after archive.
## Requirements
### Requirement: Declared api_call tools are reachable during a run
An agent whose manifest declares `api_call` tools SHALL have those tools exposed to the model for the duration of a run, and a tool the model elects to call SHALL result in an HTTP request to the owning app at `{base_url}{endpoint.path}` using the declared method. The gateway SHALL present the app's active app token on that request. This SHALL hold regardless of which configured provider the agent is routed to, since tool exposure is a property of the run rather than of the provider. A tool that declares a `when` clause SHALL be exposed only when that clause matches the request's context; a tool that declares no `when` clause SHALL always be exposed.

#### Scenario: Model-elected tool reaches the app
- **WHEN** an agent declaring an `api_call` tool is run and the model emits a tool call for it
- **THEN** the app's declared endpoint receives a request carrying the model-generated arguments and `Authorization: Bearer <app_token>`

#### Scenario: Tool exposure is provider-independent
- **WHEN** the same agent is routed to a different configured provider
- **THEN** its declared tools are exposed identically, with no provider-specific gating

#### Scenario: Agent without tools exposes none
- **WHEN** an agent declares an empty `tools` array
- **THEN** the run exposes no app tools and no tool server is attached

#### Scenario: Tool without a when clause is unaffected by context
- **WHEN** an agent's tool declares no `when` clause
- **THEN** it is exposed whether or not the request carries a context

### Requirement: Discovered MCP tools are reachable during a run
An agent whose manifest declares an `mcp` server SHALL have that server's discovered tools exposed to the model for the duration of a run, and a tool the model elects to call SHALL result in a `tools/call` request to the declared server carrying the model-generated arguments and any `headers` declared on the entry. The server prefix SHALL be stripped from the exposed name before the call, so the server receives the tool's own name. As with `api_call` tools, exposure SHALL be independent of which configured provider the agent is routed to, and an `mcp` entry that declares a `when` clause SHALL be exposed only when that clause matches the request's context.

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

### Requirement: `when` clauses filter the exposed tool set against the request context
The gateway SHALL evaluate each declared tool's optional `when` clause against the request's context and SHALL expose only the tools whose clause matches. A `when` clause is an object of path-to-matcher entries, all of which SHALL hold for the clause to match. Paths SHALL be dot notation into the context. Matchers SHALL be: a scalar (strict equality against the value at the path), an array of scalars (matching if the value equals any element), `{ "prefix": <string> }` (the string value at the path starts with the prefix), or `{ "exists": <boolean> }` (the path is present or absent). A path absent from the context SHALL fail every matcher except `{ "exists": false }`. A request carrying no context SHALL be evaluated as the empty object, so every `when`-carrying tool is filtered out. Filtering SHALL be applied before MCP discovery, so an `mcp` entry whose `when` does not match is not connected to at all, and a matching `mcp` entry exposes every tool it advertises. Tools filtered out SHALL be logged by name at `debug`.

#### Scenario: Page-scoped tool exposed on its page
- **WHEN** a tool declares `when: { "route": "/imports/preview" }` and the request context sets that route
- **THEN** the tool is exposed to the model

#### Scenario: Page-scoped tool hidden elsewhere
- **WHEN** the same tool is run with a context whose `route` is `/accounts/acc_42`
- **THEN** the tool is not exposed and its name appears in a `debug` log of filtered tools

#### Scenario: Contextless request hides gated tools
- **WHEN** a request supplies no `iri_context` and an agent declares a tool with any `when` clause
- **THEN** that tool is not exposed, while the agent's `when`-less tools are

#### Scenario: Array matcher matches any member
- **WHEN** a tool declares `when: { "route": ["/imports/preview", "/imports/review"] }` and the context supplies either route
- **THEN** the tool is exposed

#### Scenario: Prefix matcher matches a route hierarchy
- **WHEN** a tool declares `when: { "route": { "prefix": "/accounts/" } }` and the context supplies `/accounts/acc_42`
- **THEN** the tool is exposed

#### Scenario: Exists matcher keys off presence alone
- **WHEN** a tool declares `when: { "import_batch_id": { "exists": true } }` and the context supplies any value for that key
- **THEN** the tool is exposed, and when the key is absent it is not

#### Scenario: All entries must hold
- **WHEN** a tool declares two `when` entries and the context satisfies only one
- **THEN** the tool is not exposed

#### Scenario: Gated mcp server is not dialed
- **WHEN** an `mcp` entry's `when` clause does not match the request context
- **THEN** the gateway makes no connection to that server and contributes none of its tools

#### Scenario: Filtering everything out is not an error
- **WHEN** every tool an agent declares is filtered out by its `when` clause
- **THEN** the run proceeds with no app tools rather than failing

### Requirement: `get_context` is exposed as a gateway-owned tool on the run's tool surface
When a run carries a non-empty context, the gateway SHALL add a `get_context` tool to the run's tool surface alongside the agent's declared tools and SHALL permit its invocation under the same permission grant. Its invocation SHALL be served by the gateway from the request's context and SHALL NOT produce any HTTP request to the owning app. When `iri_show_tool_calls=true` is set, a `get_context` invocation SHALL appear in the reported tool calls like any other.

#### Scenario: Tool is invocable, not merely declared
- **WHEN** a run carries a context and the model calls `get_context`
- **THEN** the call is permitted and returns a result rather than being denied

#### Scenario: No app request is made
- **WHEN** the model calls `get_context`
- **THEN** the owning app receives no HTTP request for that call

#### Scenario: Visible under the tool-call flag
- **WHEN** a request sets `iri_show_tool_calls=true` and the model calls `get_context`
- **THEN** the invocation appears in the reported tool calls in invocation order

