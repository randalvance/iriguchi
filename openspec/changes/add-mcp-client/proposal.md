## Why

Every tool an iriguchi agent can reach today is one a registering app pushed at the gateway: the app declares `api_call` tools in its manifest and the gateway calls back into that app over HTTP. That works only for capabilities an app is willing to wrap in bespoke REST endpoints. MCP inverts the direction — the gateway opens a connection *out* to a server and *discovers* what it offers — and it is the interop format tool servers are actually being written in. finance-app already runs one: a deployed, verified, read-only MCP server exposing six finance tools that no `api_call` manifest describes.

Without MCP client support, reaching those six tools means finance-app duplicating each one as a REST endpoint in its manifest — re-implementing a protocol it already speaks.

## What Changes

- **New `type: "mcp"` member of `ToolSchema`.** An agent's `tools` array may now contain MCP *server* declarations alongside `api_call` tool declarations. One `mcp` entry names a server, its URL, and optional headers; it expands at run time into however many tools that server advertises. This is the first entry in `tools` that is one-to-many rather than one-to-one.
- **Discovery.** The gateway performs `initialize` + `tools/list` against a declared server the first time a run needs it, caches the result with a TTL, and refreshes stale entries on the existing background-refresh tick. Boot never blocks on an unreachable MCP server.
- **Namespacing.** Discovered tools are exposed to the model as `<server_name>__<tool_name>` (e.g. `finance__list_accounts`), so MCP tools cannot collide with `api_call` names. A prefixed name that still collides is rejected at registration.
- **Invocation.** `src/agent/tools.ts` becomes a dispatcher on `tool.type`. `invokeApiCallTool` is unchanged; a new `invokeMcpTool` issues `tools/call` and folds all three MCP failure modes — transport, JSON-RPC error, and `isError: true` tool results — into the *existing* `{ error: { ... } }` result contract rather than inventing a second one.
- **Client library.** `@modelcontextprotocol/sdk` is added as a dependency and used with `StreamableHTTPClientTransport`.
- **New gateway config.** `IRI_MCP_ALLOWED_ORIGINS` (optional origin allowlist for server URLs a manifest may declare) and `IRI_MCP_CACHE_TTL_MS`. Because MCP server URLs now arrive from registering apps, the gateway can be pointed at arbitrary hosts by a registration; the allowlist bounds that. Unset means unrestricted, preserving current behavior for deployments that do not care.
- **No authentication is invented.** finance-mcp has none — reachability is its entire access control. The `headers` field exists so a future server *can* carry a credential; nothing populates it now.
- Not breaking: manifests that declare no `mcp` entries behave exactly as before, and `api_call` semantics are untouched.

## Capabilities

### New Capabilities
- `mcp-tool-discovery`: how a declared MCP server is connected to, what `tools/list` yields, how discovered tools are namespaced and cached, when the cache is refreshed, and what happens when a server is unreachable or advertises a colliding name.

### Modified Capabilities
- `agent-tool-invocation`: the requirement that declared tools are reachable during a run currently speaks only of `api_call`. It gains MCP invocation — `tools/call` against the declared server — and extends the "tool results are folded back into the run" requirement to cover MCP's three distinct failure modes, all of which must yield an error payload to the model rather than aborting the run.
- `app-registration`: manifest validation gains MCP-specific rules — URL well-formedness, origin allowlist enforcement, and prefixed-name collision detection — that must fail a registration rather than surface at run time.

## Impact

**Code**
- `src/registry/schema.ts` — `ToolSchema` union gains `McpServerTool`; `Tool` type widens, which is a compile-time fan-out to every consumer.
- `src/agent/tools.ts` — `invokeApiCallTool` gains a sibling and a dispatcher above it.
- `src/agent/mcp/` (new) — client construction, connection pooling, `tools/list` cache, error mapping.
- `src/agent/runner.ts` — the `agent.tools.map(...)` block that builds SDK tools must first expand `mcp` entries into their discovered tools; `allowedTools` must list the prefixed names. `json-schema-to-zod.ts` is reused unchanged, since `tools/list` returns JSON Schema.
- `src/registry/refresher.ts` — the tick also refreshes stale MCP tool caches.
- `src/config.ts` — two new vars.
- `package.json` — `@modelcontextprotocol/sdk`.
- `tests/helpers/fake-mcp-server.ts` (new), plus unit and integration tests in the existing style.

**Deployment**
- finance-app declares the server in its own manifest, so the URL is finance-app's config, not iriguchi's — `http://finance-mcp.finance-app.svc.cluster.local:8080/mcp` in-cluster. iriguchi's chart gets `IRI_MCP_ALLOWED_ORIGINS` only. The service stays ClusterIP with no Ingress; it is unauthenticated and serves full financial history.

**Relationship to `adopt-openai-responses-api`**
That in-flight change removes `@anthropic-ai/claude-agent-sdk` and rewrites `runner.ts`, but states that `src/agent/tools.ts` is reused as-is. This change is built to survive it: everything except the ~15-line tool-declaration block in `runner.ts` lives behind the `tools.ts` dispatcher and is transport-agnostic. Under the Responses loop, discovered MCP tools map to Responses `function` tools exactly as `api_call` tools will. The two changes touch overlapping lines in `runner.ts` and should not be implemented concurrently.
