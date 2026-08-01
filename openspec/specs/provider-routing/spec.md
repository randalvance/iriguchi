# provider-routing

## Purpose

Configure named Anthropic-shaped providers (registry, per-provider default models, default provider), select a provider per agent via the manifest, resolve model and credentials per request without cross-request leakage, and validate provider references at registration/refresh time.
## Requirements
### Requirement: Named provider registry from environment
The gateway SHALL build its provider registry from env-var triples `IRI_PROVIDER_<NAME>_API_KEY`, `IRI_PROVIDER_<NAME>_BASE_URL`, and `IRI_PROVIDER_<NAME>_DEFAULT_MODEL`, where `<NAME>` matches `[A-Z0-9]+`. Registry keys SHALL be the lowercased name. All three vars are required per provider; the legacy vars `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, and `IRI_DEFAULT_MODEL` SHALL NOT be read.

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

### Requirement: Default provider resolution
The gateway SHALL resolve a default provider at startup: `IRI_DEFAULT_PROVIDER` when set (which MUST name a configured provider), otherwise the sole configured provider, and SHALL fail startup when multiple providers are configured without an explicit default.

#### Scenario: Single provider is implicit default
- **WHEN** exactly one provider is configured and `IRI_DEFAULT_PROVIDER` is unset
- **THEN** that provider is the default

#### Scenario: Multiple providers require explicit default
- **WHEN** two or more providers are configured and `IRI_DEFAULT_PROVIDER` is unset
- **THEN** startup throws listing the candidate names

#### Scenario: Unknown default rejected
- **WHEN** `IRI_DEFAULT_PROVIDER` names a provider that is not configured
- **THEN** startup throws listing the configured names

### Requirement: Agent-owned provider selection
An agent manifest MAY declare an optional non-empty `provider` field naming a gateway-configured provider. Requests routed to an agent SHALL use the agent's provider when set, otherwise the default provider. Vanilla requests (no `iri_agent`) SHALL use the default provider. The gateway SHALL NOT accept client-side provider selection in the request body.

#### Scenario: Agent provider wins over default
- **WHEN** a chat request targets an agent whose manifest sets `provider: openrouter` and the gateway default is `lmstudio`
- **THEN** the request is executed against the `openrouter` provider's baseUrl and apiKey

#### Scenario: Vanilla request uses default provider
- **WHEN** a chat request has no `iri_agent` field
- **THEN** the request is executed against the default provider

### Requirement: Per-request model resolution
The gateway SHALL resolve the model as `request.model`, else the agent's `default_model`, else the routed provider's `defaultModel`. Model names are passed through verbatim; the requested model SHALL NOT influence provider routing.

#### Scenario: Agent without default_model inherits routed provider default
- **WHEN** an agent sets `provider: anthropic` but omits `default_model`, and the anthropic provider's default model is `claude-opus-5`
- **THEN** the request runs with model `claude-opus-5`, not the gateway default provider's model

#### Scenario: Request model wins
- **WHEN** the request body includes a `model` value
- **THEN** that value is used verbatim regardless of agent or provider defaults

### Requirement: Credential isolation under concurrency
Concurrent requests routed to different providers SHALL each use their own provider's credentials and base URL, with no cross-request leakage and no mutation of the gateway process environment.

#### Scenario: Concurrent requests to two providers stay isolated
- **WHEN** two chat requests targeting agents on two different providers run concurrently
- **THEN** each upstream request arrives at its own provider's baseUrl carrying that provider's apiKey

### Requirement: Provider validation at registration and refresh
Registration and manual manifest refresh SHALL reject a manifest atomically with HTTP 400, type `invalid_request_error`, code `unknown_provider`, when any agent references an unconfigured provider. Background refresh SHALL instead log a structured warning and retain the previously cached manifest. A request-time lookup of a provider missing from config SHALL fail with HTTP 500, code `unknown_provider`.

#### Scenario: Registration rejects unknown provider
- **WHEN** `POST /apps/register` submits a manifest where one agent sets `provider: nonexistent`
- **THEN** the whole manifest is rejected with 400 `unknown_provider` naming the agent, the provider, and the configured list

#### Scenario: Background refresh keeps stale manifest
- **WHEN** a background refresh fetches a manifest referencing a provider no longer configured
- **THEN** the gateway logs `manifest.refresh_failed` with reason `unknown_provider` and continues serving the prior manifest

### Requirement: Model listing reflects the default provider
`GET /v1/models` SHALL list exactly the default provider's `defaultModel` and SHALL NOT include hardcoded model ids.

#### Scenario: Models endpoint with LM Studio default
- **WHEN** the default provider is `lmstudio` with default model `ornith-1.0-35b`
- **THEN** `/v1/models` returns exactly one model entry, `ornith-1.0-35b`

### Requirement: Per-provider credential style
A provider MAY declare how its credential is presented to the agent runtime via the optional env var `IRI_PROVIDER_<NAME>_AUTH_STYLE`, whose value SHALL be either `api_key` or `auth_token`. When the var is absent the style SHALL default to `api_key`, so every currently-configured provider keeps its present behavior. An unrecognized value SHALL fail startup with an error naming the provider and the accepted values, consistent with the fail-fast validation of the rest of the provider triple. The style SHALL NOT affect provider selection, model resolution, or registration-time validation.

#### Scenario: Default style when unset
- **WHEN** a provider is configured with only the three-var triple
- **THEN** its resolved `authStyle` is `api_key`

#### Scenario: Explicit auth_token style parses
- **WHEN** `IRI_PROVIDER_OPENROUTER_AUTH_STYLE` is set to `auth_token`
- **THEN** `config.providers.openrouter.authStyle` is `auth_token`

#### Scenario: Unknown style fails startup
- **WHEN** a provider's `AUTH_STYLE` is set to any value other than `api_key` or `auth_token`
- **THEN** startup throws an error naming the provider and listing the accepted values

#### Scenario: Style is per-provider
- **WHEN** two providers are configured with different auth styles
- **THEN** each resolves its own style independently, and neither affects the other's credentials

### Requirement: Credential export matches the provider's auth style
When executing a run, the gateway SHALL export the routed provider's credential to the agent runtime according to that provider's auth style. For `api_key`, `ANTHROPIC_API_KEY` SHALL carry the provider's key. For `auth_token`, `ANTHROPIC_AUTH_TOKEN` SHALL carry the provider's key and `ANTHROPIC_API_KEY` SHALL be exported as an empty string — present but empty, because an absent value causes the agent runtime to fall back to authenticating against Anthropic directly, silently bypassing the configured provider. In both styles `ANTHROPIC_BASE_URL` SHALL carry the provider's base URL, and no other provider's credentials SHALL be visible to the run.

#### Scenario: api_key provider exports the key
- **WHEN** a run is routed to a provider whose style is `api_key`
- **THEN** the run's environment has `ANTHROPIC_API_KEY` set to that provider's key and `ANTHROPIC_BASE_URL` set to its base URL

#### Scenario: auth_token provider exports token and blanks the key
- **WHEN** a run is routed to a provider whose style is `auth_token`
- **THEN** the run's environment has `ANTHROPIC_AUTH_TOKEN` set to that provider's key and `ANTHROPIC_API_KEY` set to the empty string

#### Scenario: Empty key is present, not absent
- **WHEN** a run is routed to an `auth_token` provider
- **THEN** `ANTHROPIC_API_KEY` exists as a key in the run's environment with an empty-string value, rather than being omitted

#### Scenario: Styles do not leak across concurrent runs
- **WHEN** runs routed to an `api_key` provider and an `auth_token` provider execute concurrently
- **THEN** neither run's environment contains the other provider's credential or base URL

