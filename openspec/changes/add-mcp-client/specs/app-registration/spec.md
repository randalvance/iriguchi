## ADDED Requirements

### Requirement: MCP entries in a manifest are validated at registration
Manifest validation SHALL, in addition to its existing schema, `app.id`, and provider checks, verify every `type: "mcp"` entry before persisting the app: `name` matches the kebab-case pattern, `url` parses as an absolute HTTP or HTTPS URL, and — when `IRI_MCP_ALLOWED_ORIGINS` is configured — the URL's origin appears in that allowlist. A violation SHALL fail the registration with a `400` validation error that names the offending agent, entry, and field, and the app SHALL NOT be persisted. Because an `mcp` entry is a reference rather than a complete tool declaration, registration SHALL NOT attempt to connect to the server or validate the tools it advertises; those failures surface at run time as discovery failures.

#### Scenario: Malformed MCP URL fails registration
- **WHEN** an app registers a manifest whose `mcp` entry has a relative or unparseable `url`
- **THEN** registration returns `400` naming the agent and the `url` field, and the app is not persisted

#### Scenario: Disallowed origin fails registration
- **WHEN** `IRI_MCP_ALLOWED_ORIGINS` is configured and a declared MCP URL's origin is absent from it
- **THEN** registration returns `400` naming the URL and the configured allowlist

#### Scenario: Registration does not contact the MCP server
- **WHEN** an app registers a manifest declaring an MCP server that is currently unreachable
- **THEN** registration succeeds, no connection is attempted, and the tools become available whenever the server is reachable

#### Scenario: Re-registration re-validates MCP entries
- **WHEN** an app re-registers with a manifest whose MCP URL has become disallowed
- **THEN** the re-registration is rejected and the previously stored app is left unchanged
