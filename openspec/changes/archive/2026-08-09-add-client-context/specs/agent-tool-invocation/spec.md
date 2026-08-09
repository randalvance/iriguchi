## MODIFIED Requirements

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

## ADDED Requirements

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
