# mcp-tool-discovery Specification

## Purpose
TBD - created by syncing change add-mcp-client. Update Purpose after archive.
## Requirements
### Requirement: An agent may declare MCP servers in its manifest
An agent's `tools` array SHALL accept entries of `type: "mcp"` alongside `type: "api_call"` entries. An `mcp` entry SHALL carry a `name` (kebab-case, matching the same pattern as agent ids) and a `url`, and MAY carry `headers` (a string map, default empty), `tools` (an allowlist of tool names to expose, default all discovered), and `timeout_ms` (default `IRI_TOOL_CALL_TIMEOUT_MS`). Unlike an `api_call` entry, which declares exactly one tool, an `mcp` entry is a reference to a server and SHALL expand into however many tools that server advertises.

#### Scenario: Manifest with an mcp entry is accepted
- **WHEN** an app registers a manifest whose agent declares `{"type": "mcp", "name": "finance", "url": "http://mcp:8080/mcp"}`
- **THEN** registration succeeds and the agent is accepted

#### Scenario: Both tool types on one agent
- **WHEN** an agent declares one `api_call` tool and one `mcp` server
- **THEN** both are accepted and both contribute tools to a run

#### Scenario: Server name must be kebab-case
- **WHEN** a manifest declares an `mcp` entry whose `name` contains an underscore or uppercase character
- **THEN** registration is rejected with a validation error naming the field

#### Scenario: Absent optional fields take their defaults
- **WHEN** an `mcp` entry omits `headers`, `tools`, and `timeout_ms`
- **THEN** no extra headers are sent, every discovered tool is exposed, and the gateway's default tool-call timeout applies

### Requirement: Tools are discovered lazily and cached with a TTL
The gateway SHALL connect to a declared MCP server and issue `tools/list` the first time a run requires that server, and SHALL NOT connect at boot. The discovered list SHALL be cached in memory, keyed by the server URL together with its headers, so that two agents declaring the same server share one cache entry and one client. A cache entry younger than `IRI_MCP_CACHE_TTL_MS` SHALL be reused without a network round-trip.

#### Scenario: Boot does not contact declared servers
- **WHEN** the gateway starts with an app registered whose agent declares an unreachable MCP server
- **THEN** startup completes normally and no connection to that server is attempted

#### Scenario: First run discovers, second run uses the cache
- **WHEN** two runs of the same agent occur within the cache TTL
- **THEN** `tools/list` is issued exactly once

#### Scenario: Two agents sharing a server share the cache
- **WHEN** two agents declare the same URL and headers and each is run once
- **THEN** `tools/list` is issued exactly once

#### Scenario: Expired entry is re-discovered
- **WHEN** a run needs a server whose cache entry is older than the TTL
- **THEN** `tools/list` is issued again and the cache entry is replaced

### Requirement: Stale tool caches are refreshed in the background
The gateway's background refresh tick SHALL, in addition to refreshing stale app manifests, re-issue `tools/list` for MCP cache entries older than `IRI_MCP_CACHE_TTL_MS`. A failed refresh SHALL be logged at `warn` and SHALL leave the previous cached entry in place rather than emptying it.

#### Scenario: Background tick refreshes a stale entry
- **WHEN** a cache entry passes its TTL and the refresh tick runs
- **THEN** the server is re-listed and the entry's fetch timestamp is updated, without any run in flight

#### Scenario: Failed background refresh preserves the previous list
- **WHEN** a background re-list fails because the server is unreachable
- **THEN** a `warn` is logged naming the server and reason, and the previously discovered tools remain available to subsequent runs

### Requirement: Discovered tools are namespaced by server
Each discovered tool SHALL be exposed to the model under the name `<server_name>__<tool_name>`. Because a server `name` cannot contain an underscore, the server SHALL be recoverable by splitting the exposed name on its first `__`. A discovered tool whose prefixed name exceeds 64 characters, contains characters outside `[A-Za-z0-9_-]`, or collides with an `api_call` tool name on the same agent SHALL be dropped from the run and logged at `warn`, without failing the run or the other tools.

#### Scenario: Tool is exposed under its prefixed name
- **WHEN** a server named `finance` advertises `list_accounts`
- **THEN** the model is offered `finance__list_accounts`

#### Scenario: Same tool name on two servers does not collide
- **WHEN** two declared servers each advertise a tool named `search`
- **THEN** both are exposed, distinguished by their server prefixes, and each call reaches the server named in its prefix

#### Scenario: Collision with an api_call name drops only that tool
- **WHEN** a discovered tool's prefixed name equals an `api_call` tool name on the same agent
- **THEN** the discovered tool is dropped with a `warn` and the run proceeds with the remaining tools

#### Scenario: Allowlist narrows what is exposed
- **WHEN** an `mcp` entry sets `tools: ["list_accounts"]` and the server advertises six tools
- **THEN** only `finance__list_accounts` is exposed to the model

### Requirement: An unreachable MCP server costs its tools, not the run
When discovery fails — transport error, timeout, non-2xx response, or a protocol-level error — the gateway SHALL log at `warn` with the server name and the reason and continue the run with whatever other tools the agent has, never surfacing the failure to the client. Where a previously discovered list is cached for that server, it SHALL be retained and used, so a server that is briefly down does not withdraw its tools mid-conversation; where none is cached, the server SHALL contribute no tools. A run whose only declared tools came from a failed, never-discovered server SHALL proceed with no tools rather than returning an error.

#### Scenario: Unreachable server degrades the run
- **WHEN** an agent declaring one `api_call` tool and one unreachable, never-discovered MCP server is run
- **THEN** the run completes with the `api_call` tool exposed, no MCP tools exposed, and a `warn` logged for the MCP server

#### Scenario: Only-MCP agent with a dead server still answers
- **WHEN** an agent whose only tools come from an unreachable, never-discovered MCP server is run
- **THEN** the run completes and returns assistant text, with no tools exposed and no client-visible error

#### Scenario: A flapping server keeps serving its last known tools
- **WHEN** a server's tools were discovered successfully and a later re-list fails because it has gone down
- **THEN** the previously discovered tools remain exposed and a `warn` is logged, rather than the agent losing them

### Requirement: MCP server URLs are constrained by an origin allowlist
When `IRI_MCP_ALLOWED_ORIGINS` is set to a comma-separated list of `scheme://host:port` origins, the gateway SHALL reject at registration any manifest declaring an `mcp` entry whose URL origin is not listed, and SHALL refuse to connect to such a URL even if it reached the store before the allowlist was set. When the variable is unset or empty, any origin SHALL be permitted.

#### Scenario: Disallowed origin is rejected at registration
- **WHEN** the allowlist is set and an app registers a manifest declaring an MCP URL outside it
- **THEN** registration fails with a validation error naming the URL and the allowlist

#### Scenario: Allowlist is re-checked at connect time
- **WHEN** a manifest containing a now-disallowed MCP URL is already in the store and a run needs that server
- **THEN** the gateway does not connect, logs a `warn`, and exposes no tools for that server

#### Scenario: Unset allowlist permits any origin
- **WHEN** `IRI_MCP_ALLOWED_ORIGINS` is unset
- **THEN** an MCP entry with any well-formed URL registers and connects normally

#### Scenario: Plain HTTP is permitted
- **WHEN** a declared URL uses `http://` rather than `https://` and its origin is allowed
- **THEN** the gateway connects, since in-cluster MCP servers are reached over plain HTTP
