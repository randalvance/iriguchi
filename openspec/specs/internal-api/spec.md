# internal-api Specification

## Purpose

Define the private HTTP surface the first-party client reads: the agent catalog, per-agent detail, MCP connection status and probing, and the chat proxy. Also fixes the two properties that make an unauthenticated surface tenable — it is opt-in and off by default, and it discloses no stored secret — and the boundary that keeps it read-only, with registration and deletion remaining on the credentialed `/apps/*` routes.

## Requirements

### Requirement: The internal surface is opt-in and unauthenticated

The gateway SHALL expose an internal HTTP surface under `/internal` only when `IRI_UI_ENABLED` is true. The variable SHALL default to `false`. When the surface is disabled, requests to any `/internal/*` path SHALL be indistinguishable from requests to any other unrouted path. When it is enabled, the gateway SHALL emit a `warn` log line at startup naming the exposure, and SHALL NOT require any credential on `/internal/*` requests. The bearer middleware protecting `/v1/*` and the app-token middleware protecting `/apps/*` SHALL NOT be applied to, nor altered by, this surface.

#### Scenario: Disabled by default
- **WHEN** the gateway starts with `IRI_UI_ENABLED` unset
- **THEN** `GET /internal/agents` returns `404` and no internal routes are registered

#### Scenario: Enabled surface takes no credential
- **WHEN** `IRI_UI_ENABLED=true` and `GET /internal/agents` is requested with no `Authorization` header
- **THEN** the gateway responds `200` with the agent catalog

#### Scenario: Enabling is announced
- **WHEN** the gateway starts with `IRI_UI_ENABLED=true`
- **THEN** a `warn` log line is emitted stating that an unauthenticated internal surface is served and that the port must not be publicly reachable

#### Scenario: Public surfaces are unaffected
- **WHEN** `IRI_UI_ENABLED=true` and `POST /v1/chat/completions` is requested without a bearer token
- **THEN** the gateway still responds `401`

### Requirement: The agent catalog is served from the registry

`GET /internal/agents` SHALL return every agent of every registered app whose manifest is present, as a JSON array. Each entry SHALL carry the agent's id, the owning app's id and base URL, the agent's description, its resolved provider name, its resolved model, the number of `api_call` tools, the number of declared MCP servers, and the number of skills. Resolution SHALL follow the same rules a run follows: an agent that omits `provider` reports the configured default provider, and an agent that omits `default_model` reports its routed provider's default model. Apps with no fetched manifest SHALL contribute no entries.

#### Scenario: Agents from multiple apps are flattened
- **WHEN** two apps are registered, one declaring two agents and one declaring one
- **THEN** `GET /internal/agents` returns three entries, each naming its owning app

#### Scenario: Inherited provider and model are resolved, not blank
- **WHEN** an agent's manifest omits both `provider` and `default_model`
- **THEN** its catalog entry reports the gateway's default provider and that provider's default model

#### Scenario: App without a manifest contributes nothing
- **WHEN** a registered app has a null stored manifest
- **THEN** no catalog entry references that app, and the request still succeeds

### Requirement: Agent detail exposes tools, MCP servers, and skills

`GET /internal/agents/:agentId` SHALL return the full read-only detail for one agent: everything in its catalog entry, plus its system prompt, its `api_call` tools (name, description, HTTP method and path, parameter schema), its declared MCP servers (server name, URL, tool allowlist, timeout, and the names — not the values — of any configured headers), and its skills (name and description). An unknown agent id SHALL yield `404` with a JSON error body.

#### Scenario: Both tool kinds are reported separately
- **WHEN** an agent declares two `api_call` tools and one `mcp` server
- **THEN** the detail response lists the two `api_call` tools and the one MCP server under distinct fields, and does not flatten them into one list

#### Scenario: Unknown agent
- **WHEN** `GET /internal/agents/does-not-exist` is requested
- **THEN** the gateway responds `404` with a JSON error body

### Requirement: Internal responses never disclose stored secrets

No `/internal/*` response body SHALL contain an app token or the value of any MCP request header. Response payloads SHALL be constructed field by field from stored records rather than by serializing those records. Configured MCP headers SHALL be reported as a list of header names only.

#### Scenario: App token is absent from every payload
- **WHEN** any `/internal/*` endpoint is exercised against a registry whose apps hold tokens
- **THEN** no response body contains any stored `app_token` value

#### Scenario: MCP header values are redacted to names
- **WHEN** an agent declares an MCP server with an `Authorization` header
- **THEN** the agent detail response lists `Authorization` as a configured header name and does not include its value

### Requirement: MCP server status is reported without network I/O

`GET /internal/mcp/servers` SHALL return one entry per distinct MCP connection (a URL plus its header set) declared across all registered agents, listing the agents that declare it, the number of tools last discovered, the time of that discovery, and a status of `ok`, `stale`, `unknown`, or `unreachable`. `ok` means a cached tool list younger than `IRI_MCP_CACHE_TTL_MS`; `stale` means an older cached list; `unknown` means no discovery has ever succeeded and none has been attempted since startup; `unreachable` means the most recent attempt failed, and the entry SHALL carry that failure's message and time. The endpoint SHALL NOT open a connection to any MCP server, and SHALL respond within its normal latency even when every declared server is down.

#### Scenario: Never-contacted server reads as unknown
- **WHEN** an agent declares an MCP server and no run has yet needed it
- **THEN** its status is `unknown` with no discovery timestamp

#### Scenario: Fresh cache reads as ok
- **WHEN** a server's tool list was discovered within the cache TTL
- **THEN** its status is `ok` with the discovered tool count and discovery time

#### Scenario: Expired cache reads as stale
- **WHEN** a server's cached tool list is older than the cache TTL
- **THEN** its status is `stale` and the previously discovered tool count is still reported

#### Scenario: Dead servers do not delay the response
- **WHEN** every declared MCP server is unreachable
- **THEN** the request completes without attempting any connection

#### Scenario: Servers shared by agents are reported once
- **WHEN** two agents declare the same URL with the same headers
- **THEN** one entry is returned naming both agents

### Requirement: Probing is explicit and confined to declared servers

`POST /internal/agents/:agentId/mcp/:serverName/probe` SHALL resolve the named server from that agent's stored manifest, attempt discovery against it, and return the outcome: on success the discovered tool count, tool names, and timestamp; on failure a status of `unreachable` with the error message and timestamp. A successful probe SHALL populate the same cache a run would populate. The endpoint SHALL NOT accept a URL, host, or header set from the request; an agent id or server name that is not present in a stored manifest SHALL yield `404` and SHALL cause no outbound request. Probing SHALL remain subject to `IRI_MCP_ALLOWED_ORIGINS`.

#### Scenario: Successful probe reports tools and warms the cache
- **WHEN** a reachable server is probed
- **THEN** the response reports the discovered tools, and a subsequent `GET /internal/mcp/servers` reports that server as `ok`

#### Scenario: Failed probe is reported, not thrown
- **WHEN** the server refuses the connection
- **THEN** the response is `200` with status `unreachable` and the transport error message, and a subsequent status read reports `unreachable` with that message

#### Scenario: Arbitrary destinations are not probeable
- **WHEN** a probe names a server that no stored manifest declares for that agent
- **THEN** the gateway responds `404` and makes no outbound request

### Requirement: Chat is proxied with the gateway's own credential

`POST /internal/chat` SHALL accept `{ agent_id, messages }`, resolve the agent through the registry, execute the same agent run that `POST /v1/chat/completions` executes in streaming mode for that agent, and stream the result back as OpenAI-shaped SSE terminating in `data: [DONE]`. The gateway SHALL supply its own provider credentials from configuration; the request SHALL NOT carry, and the response SHALL NOT disclose, `IRI_API_KEY` or any provider key. The endpoint SHALL NOT satisfy the run by issuing an HTTP request to the gateway's own `/v1` surface. An unknown `agent_id` SHALL yield `404` before any provider call. Runs SHALL be bounded by the same `IRI_MAX_AGENT_TURNS` and `IRI_REQUEST_TIMEOUT_MS` limits that apply to `/v1`.

#### Scenario: Streamed agent response without a client credential
- **WHEN** `POST /internal/chat` is called with a valid `agent_id`, a user message, and no `Authorization` header
- **THEN** the gateway streams `chat.completion.chunk` events for that agent's run and ends with `data: [DONE]`

#### Scenario: No gateway credential reaches the client
- **WHEN** any `/internal/chat` response is read in full, including its error paths
- **THEN** neither `IRI_API_KEY` nor any configured provider API key appears in the bytes sent

#### Scenario: Unknown agent short-circuits
- **WHEN** `agent_id` names no registered agent
- **THEN** the gateway responds `404` with a JSON error body and makes no provider request

#### Scenario: Errors mid-stream are surfaced
- **WHEN** the agent run fails after streaming has begun
- **THEN** the stream conveys the failure to the client rather than closing silently
