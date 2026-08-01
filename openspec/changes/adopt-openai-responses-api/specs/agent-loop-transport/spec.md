# agent-loop-transport

## ADDED Requirements

### Requirement: The gateway runs the agent loop against a Responses provider
The gateway SHALL execute agent runs by calling the routed provider's Responses endpoint directly, without an intermediate agent framework. It SHALL construct each request with the resolved model, the agent's `system_prompt` as `instructions` (or the gateway's generic instructions when no agent is selected), the caller's input items, and the agent's declared `api_call` tools translated into Responses `function` tool declarations. The provider credential SHALL be presented as `Authorization: Bearer <provider key>` on the request, and SHALL NOT be written into the process environment or into any subprocess.

#### Scenario: Agent prompt becomes instructions
- **WHEN** a run targets an agent with a `system_prompt`
- **THEN** the provider request carries that prompt as `instructions`

#### Scenario: Declared tools become function tools
- **WHEN** an agent declares `api_call` tools
- **THEN** the provider request declares a `function` tool per `api_call` tool, carrying its name, description, and `parameters` schema

#### Scenario: Credential is per-request, not ambient
- **WHEN** a run executes
- **THEN** the provider key is sent as a request header and no provider credential is exported into the process or a subprocess environment

#### Scenario: Agent with no tools declares none
- **WHEN** an agent declares an empty `tools` array
- **THEN** the provider request declares no tools

### Requirement: Function calls are executed and fed back
When a provider response contains `function_call` items, the gateway SHALL invoke the corresponding app endpoint for each, append a `function_call_output` item carrying the result and the originating call id, and issue a follow-up request including the accumulated items. This SHALL repeat until a response contains no `function_call` items. A call naming a tool the agent does not declare SHALL yield an error result rather than an outbound request.

#### Scenario: Tool result drives the next turn
- **WHEN** a response contains a `function_call` and the app returns data
- **THEN** the gateway issues a follow-up request whose input includes a `function_call_output` matching the call id, and the final text may derive from it

#### Scenario: Several calls in one turn are all executed
- **WHEN** a single response contains multiple `function_call` items
- **THEN** each is invoked and each produces its own `function_call_output` in the follow-up request

#### Scenario: Failing tool does not abort the run
- **WHEN** an app endpoint returns non-2xx, times out, or is unreachable
- **THEN** the corresponding `function_call_output` carries an error payload and the loop continues

#### Scenario: Undeclared tool is refused locally
- **WHEN** a response requests a function the agent's manifest does not declare
- **THEN** the gateway produces an error result for that call and makes no outbound app request

### Requirement: Runs are bounded and terminal state is reported
The gateway SHALL bound each run at `IRI_MAX_AGENT_TURNS` provider round trips. On reaching the bound it SHALL stop issuing requests and report the run as turn-limited rather than as completed, so a client can distinguish a finished answer from a truncated one. Turn bounding SHALL be enforced by the gateway itself rather than delegated.

#### Scenario: Loop stops at the bound
- **WHEN** a provider keeps emitting `function_call` items indefinitely
- **THEN** the gateway stops after the configured number of round trips and makes no further provider calls

#### Scenario: Turn-limited runs are distinguishable
- **WHEN** a run ends by hitting the bound
- **THEN** the surface reports a turn-limited terminal state rather than a normal completion

#### Scenario: Normal completion is not turn-limited
- **WHEN** a run finishes because the provider returned no further tool calls
- **THEN** the terminal state reports normal completion

### Requirement: Provider failures are classified, not passed through raw
A non-2xx from the provider SHALL be surfaced with the provider's status and message preserved in a structured gateway error, not flattened into an opaque internal error. Transport failures — connection refused, timeout — SHALL be reported distinctly from provider-rejected requests, so an operator can tell "the provider is down" from "the provider refused this request".

#### Scenario: Provider rejection preserves cause
- **WHEN** the provider returns a 4xx with an error body
- **THEN** the gateway's error carries the provider's status and message rather than a generic internal error

#### Scenario: Provider unreachable is distinct
- **WHEN** the provider connection is refused or times out
- **THEN** the gateway reports a transport failure distinguishable from a provider rejection

#### Scenario: Tool declarations rejected by the provider are attributable
- **WHEN** a provider rejects a request because of its tool declarations
- **THEN** the surfaced error identifies the provider's rejection and its message, rather than reporting an unhandled internal error
