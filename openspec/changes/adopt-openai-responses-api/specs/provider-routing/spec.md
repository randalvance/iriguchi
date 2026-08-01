# provider-routing

## MODIFIED Requirements

### Requirement: Named provider registry from environment
The gateway SHALL build its provider registry from env-var triples `IRI_PROVIDER_<NAME>_API_KEY`, `IRI_PROVIDER_<NAME>_BASE_URL`, and `IRI_PROVIDER_<NAME>_DEFAULT_MODEL`, where `<NAME>` matches `[A-Z0-9]+`. Registry keys SHALL be the lowercased name. All three vars are required per provider; the legacy vars `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, and `IRI_DEFAULT_MODEL` SHALL NOT be read. `BASE_URL` SHALL denote an endpoint serving the OpenAI Responses API; providers are Responses-shaped rather than Anthropic-shaped, and a provider offering only an Anthropic Messages surface is no longer usable.

#### Scenario: Complete provider parses
- **WHEN** the env contains `IRI_PROVIDER_LMSTUDIO_API_KEY`, `IRI_PROVIDER_LMSTUDIO_BASE_URL`, and `IRI_PROVIDER_LMSTUDIO_DEFAULT_MODEL`
- **THEN** `config.providers.lmstudio` exists with `name`, `apiKey`, `baseUrl`, and `defaultModel` populated from those vars

#### Scenario: Half-configured provider fails startup
- **WHEN** any one or two of a provider's three vars are set but the rest are missing
- **THEN** startup throws an error naming the provider and the first missing var suffix

#### Scenario: No providers fails startup
- **WHEN** no `IRI_PROVIDER_*` vars are present
- **THEN** startup throws an error instructing the operator to set the three-var triple

#### Scenario: Stale global default model fails startup
- **WHEN** `IRI_DEFAULT_MODEL` is present in the env
- **THEN** startup throws an error pointing to `IRI_PROVIDER_<NAME>_DEFAULT_MODEL`

#### Scenario: Base URL addresses the Responses endpoint
- **WHEN** a run is routed to a configured provider
- **THEN** the outbound request targets that provider's Responses endpoint derived from its `baseUrl`

### Requirement: Credential isolation under concurrency
Concurrent requests routed to different providers SHALL each use their own provider's credentials and base URL, with no cross-request leakage and no mutation of the gateway process environment. Credentials SHALL be carried as per-request `Authorization` headers; the gateway SHALL NOT export provider credentials into the process environment or into any subprocess, and an ambient `ANTHROPIC_API_KEY` in the gateway's environment SHALL have no effect on provider selection or authentication.

#### Scenario: Concurrent requests to two providers stay isolated
- **WHEN** two chat requests targeting agents on two different providers run concurrently
- **THEN** each upstream request arrives at its own provider's baseUrl carrying that provider's apiKey

#### Scenario: Credentials travel as headers only
- **WHEN** a run executes against any provider
- **THEN** the provider key appears in that request's `Authorization` header and in no environment variable

#### Scenario: Ambient Anthropic credentials are inert
- **WHEN** the gateway process environment contains `ANTHROPIC_API_KEY` or `ANTHROPIC_BASE_URL`
- **THEN** neither affects which provider is used nor how the request is authenticated
