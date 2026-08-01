# provider-routing

## ADDED Requirements

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
