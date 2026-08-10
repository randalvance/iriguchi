# app-registration Specification

## Purpose
TBD - created by archiving change fix-app-integration-handshake. Update Purpose after archive.
## Requirements
### Requirement: Manifest endpoint is authenticated by Bearer presence only
An app's `GET /agents-manifest` endpoint SHALL be authenticated by the *presence* of a non-empty `Authorization: Bearer <token>` header and SHALL NOT require that token to equal the app's active app token. The gateway SHALL document this as a normative requirement of the app contract, stating the reason: the gateway mints the app token immediately before the first manifest fetch, so during initial registration the app cannot yet know the token it is being presented. The manifest carries only agent definitions, prompts, tool schemas, and endpoint paths — never app data — so presence-only authentication does not expose user or business data.

#### Scenario: Manifest served to a token the app has never seen
- **WHEN** the gateway fetches `{base_url}/agents-manifest` with a freshly minted app token during `POST /apps/register`
- **THEN** a contract-conformant app returns `200` with its manifest, because it checked only that a non-empty Bearer token was present

#### Scenario: Missing Authorization header rejected
- **WHEN** `GET /agents-manifest` is requested with no `Authorization` header
- **THEN** the app returns `401`

#### Scenario: Malformed or empty Bearer rejected
- **WHEN** `GET /agents-manifest` is requested with an `Authorization` header that does not start with `Bearer `, or whose token portion is empty
- **THEN** the app returns `401`

### Requirement: Tool endpoints require exact app-token equality
The gateway SHALL present the app's active app token as `Authorization: Bearer <app_token>` on every `api_call` tool invocation. App tool endpoints SHALL authenticate by constant-time equality against the active app token and SHALL reject any other token. The presence-only relaxation applies to `GET /agents-manifest` alone; it SHALL NOT be extended to tool endpoints, which do carry app data.

#### Scenario: Tool call with the active token succeeds
- **WHEN** the gateway invokes an app tool endpoint with the app token stored for that app
- **THEN** the endpoint authenticates the request and serves it

#### Scenario: Tool call with a stale or arbitrary token rejected
- **WHEN** a tool endpoint receives a Bearer token that is non-empty but does not equal the active app token — including a token rotated away by a later re-registration
- **THEN** the endpoint returns `401` and performs no work

### Requirement: Registration mints the app token before fetching the manifest
`POST /apps/register` SHALL generate a new app token, fetch `{base_url}/agents-manifest` presenting that token, validate the manifest (schema, `app.id` equal to the registered `id`, all `provider` references configured), and only then persist the app and return the token to the caller. Re-registration SHALL rotate the token, and the rotated token SHALL be the one presented on the manifest fetch for that registration.

#### Scenario: Token returned only after a successful manifest fetch
- **WHEN** registration succeeds
- **THEN** the response body contains the `app_token` that was presented on the manifest fetch, along with `accepted_agents`

#### Scenario: Failed registration does not persist or leak the minted token
- **WHEN** the manifest fetch or validation fails
- **THEN** the app is not persisted and the minted token is not returned to the caller

### Requirement: Manifest fetch rejection is diagnosed distinctly
When a manifest fetch fails because the app rejected the gateway's credentials — HTTP `401` or `403` — the gateway SHALL respond `502` with error `type: "app_unavailable"` and `code: "manifest_unauthorized"` and a message that names the cause and the fix: the app token is minted immediately before this fetch, the app cannot know it yet during initial registration, and `GET /agents-manifest` must accept any non-empty Bearer token. All other fetch failures (network error, timeout, other non-2xx statuses, invalid JSON, schema violation) SHALL keep their existing `app_unavailable` classification. The gateway SHALL log the rejection at `warn` with the app id and the upstream status.

#### Scenario: 401 from the manifest endpoint during registration
- **WHEN** `POST /apps/register` fetches the manifest and the app responds `401`
- **THEN** the gateway returns `502` with `code: "manifest_unauthorized"` and a message explaining the token-ordering circularity and the presence-only requirement

#### Scenario: 403 is diagnosed the same way
- **WHEN** the app responds `403` to the manifest fetch
- **THEN** the gateway returns the same `manifest_unauthorized` diagnosis

#### Scenario: Other failures keep app_unavailable
- **WHEN** the manifest fetch times out, fails to connect, returns `500`, or returns a body that fails schema validation
- **THEN** the gateway returns `502` with `code: "app_unavailable"` and the existing message

#### Scenario: Refresh gets the same diagnosis
- **WHEN** `POST /apps/:id/refresh-manifest` fetches the manifest with the app's stored token and the app responds `401` or `403`
- **THEN** the gateway returns the `manifest_unauthorized` error rather than a generic `app_unavailable`

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

### Requirement: Manifest tools may declare a `when` clause, validated at registration
The manifest schema SHALL accept an optional `when` clause on both `api_call` and `mcp` tool entries. The clause SHALL be an object whose values are each a scalar, an array of scalars, `{ "prefix": <string> }`, or `{ "exists": <boolean> }`. Registration SHALL reject a manifest containing a malformed `when` clause — a non-object clause, an empty clause, an unrecognized matcher form, or an empty path key — with the existing atomic manifest-validation failure, so a matcher that could never match surfaces at registration rather than as a tool that silently never appears. A manifest with no `when` clauses SHALL validate exactly as it does today.

#### Scenario: Valid when clause accepted
- **WHEN** an app registers a manifest whose tool declares `when: { "route": { "prefix": "/accounts/" } }`
- **THEN** registration succeeds and the clause is persisted with the tool

#### Scenario: Malformed matcher rejected atomically
- **WHEN** a manifest declares `when: { "route": { "regex": "^/acc" } }`
- **THEN** registration fails validation, the whole manifest is rejected, and the app is not persisted

#### Scenario: Empty clause rejected
- **WHEN** a manifest declares `when: {}` on a tool
- **THEN** registration fails validation with a message naming the tool

#### Scenario: Existing manifests unaffected
- **WHEN** an app registers a manifest with no `when` clauses anywhere
- **THEN** validation and the accepted agent set are unchanged from before this capability existed

### Requirement: `get_context` is a reserved tool name
Registration SHALL reject a manifest declaring an `api_call` tool named `get_context` with `400`, `type: "invalid_request_error"`, and `code: "reserved_tool_name"`, naming the tool and the reason, because the gateway exposes its own tool under that name. `mcp` entries SHALL NOT be constrained by this reservation, since their tools reach the model prefixed by the server name and cannot collide.

#### Scenario: Reserved api_call name rejected
- **WHEN** a manifest declares an `api_call` tool named `get_context`
- **THEN** registration fails with `400` and `code: "reserved_tool_name"` and the app is not persisted

#### Scenario: Prefixed mcp tool of the same name is allowed
- **WHEN** an `mcp` server named `finance` advertises a tool called `get_context`
- **THEN** it is exposed as `finance__get_context` and does not collide with the gateway's tool

