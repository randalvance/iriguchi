# agent-tool-invocation Specification

## Purpose
TBD - created by archiving change add-openrouter-provider. Update Purpose after archive.
## Requirements
### Requirement: Declared api_call tools are reachable during a run
An agent whose manifest declares `api_call` tools SHALL have those tools exposed to the model for the duration of a run, and a tool the model elects to call SHALL result in an HTTP request to the owning app at `{base_url}{endpoint.path}` using the declared method. The gateway SHALL present the app's active app token on that request. This SHALL hold regardless of which configured provider the agent is routed to, since tool exposure is a property of the run rather than of the provider.

#### Scenario: Model-elected tool reaches the app
- **WHEN** an agent declaring an `api_call` tool is run and the model emits a tool call for it
- **THEN** the app's declared endpoint receives a request carrying the model-generated arguments and `Authorization: Bearer <app_token>`

#### Scenario: Tool exposure is provider-independent
- **WHEN** the same agent is routed to a different configured provider
- **THEN** its declared tools are exposed identically, with no provider-specific gating

#### Scenario: Agent without tools exposes none
- **WHEN** an agent declares an empty `tools` array
- **THEN** the run exposes no app tools and no tool server is attached

### Requirement: Tool results are folded back into the run
A tool's response SHALL be returned to the model as the result of its call, and the model's subsequent output SHALL be able to incorporate it. A tool that fails — non-2xx, timeout, or network error — SHALL yield an error payload to the model rather than aborting the run, so the model can react to it. The final assistant text SHALL reflect the completed multi-turn exchange, not just the turn that requested the tool.

#### Scenario: Result reaches the model's next turn
- **WHEN** an agent calls a tool that returns data, and the model then produces text derived from it
- **THEN** the run's final assistant content contains that derived text

#### Scenario: Failing tool does not abort the run
- **WHEN** a declared tool endpoint returns a non-2xx response
- **THEN** the model receives an error payload as the tool result and the run continues to completion

### Requirement: End-to-end tool invocation is verified without live credentials
The test suite SHALL include a provider-agnostic test that exercises the full tool loop — declaration, model-elected call, app request, result, and final answer — against a scripted provider, so it runs in the default suite with no API key and no network. Coverage of the tool loop SHALL NOT depend solely on tests gated behind live-credential flags.

#### Scenario: Full loop runs in the default suite
- **WHEN** the default test suite is run with no provider credentials configured
- **THEN** a test exercising the complete tool loop executes and passes rather than being skipped

#### Scenario: Failure is attributable
- **WHEN** the tool loop breaks
- **THEN** the failing assertion identifies which stage broke — tool exposure, app request, result hand-back, or final answer

