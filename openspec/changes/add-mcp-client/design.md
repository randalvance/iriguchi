## Context

iriguchi's tool model runs one direction: an app registers, pushes a manifest of `api_call` tools, and the gateway calls back into that app at `{base_url}{endpoint.path}` carrying the app token. `src/agent/tools.ts` is the whole invocation surface — 95 lines, one function, `throw new Error("unsupported tool type")` on anything else. `src/agent/runner.ts` maps `agent.tools` one-to-one into `@anthropic-ai/claude-agent-sdk` tools via `createSdkMcpServer`, converting each tool's JSON Schema `parameters` with `json-schema-to-zod.ts`.

MCP inverts this. The gateway dials *out* to a server it does not own and asks it what it has. The first such server is finance-app's, deployed and verified:

- Stateless streamable HTTP at `POST /mcp`. No session id issued or needed — `tools/list` works without a prior `initialize`.
- `GET` and `DELETE` on `/mcp` answer `405`: no SSE stream to open, no session to close.
- Protocol `2025-06-18`, `serverInfo {name: "finance-app", version: "0.1.0"}`, capabilities `{tools: {listChanged: true}}`.
- Requires both `Content-Type: application/json` and `Accept: application/json, text/event-stream`.
- Six read-only tools: `list_accounts`, `get_account_balance`, `list_categories`, `list_tags`, `list_transactions`, `get_transaction`.
- No authentication of any kind. Reachability is the entire access control, which is why it is ClusterIP with no Ingress.

Two constraints shape everything below.

**The in-flight `adopt-openai-responses-api` change removes the Agent SDK** and rewrites `runner.ts` around a gateway-owned Responses loop — while explicitly keeping `src/agent/tools.ts` "reused as-is". Anything built on SDK-native MCP support is work that gets deleted; anything behind the `tools.ts` dispatcher survives.

**The existing `tools.ts` result contract is load-bearing.** It returns either the app's JSON or `{ error: { kind: "timeout" | "network", message } }` / `{ error: { status, body } }`, and `agent-tool-invocation` requires that a failing tool yields an error payload to the model rather than aborting the run. MCP errors fold into that shape; they do not get a second one.

## Goals / Non-Goals

**Goals:**
- An agent can declare an MCP server in its manifest and have that server's tools exposed to the model and invocable during a run.
- MCP tools and `api_call` tools coexist on one agent without name collisions.
- All three MCP failure modes reach the model as data, never as an aborted run.
- Discovery failure degrades: an unreachable MCP server costs its tools, not the run.
- Nothing in `src/agent/mcp/` depends on the Agent SDK, so the Responses rewrite carries it forward unchanged.

**Non-Goals:**
- **Authentication.** finance-mcp checks nothing. A `headers` field exists so a future server can carry a credential; no credential store, no OAuth, no token refresh.
- **`listChanged` notifications.** The server advertises the capability, but a stateless transport that 405s `GET` has no channel to deliver one. TTL is the only invalidation.
- **Stdio / local MCP servers.** HTTP only.
- **Persisting discovered tool lists.** In-memory cache; see Decision 4.
- **Sampling, resources, prompts, roots.** `tools/list` and `tools/call` only.
- Exposing finance-mcp outside the cluster. It is unauthenticated and serves full financial history.

## Decisions

### 1. MCP servers are declared per-agent in the manifest, as a new `ToolSchema` member

```jsonc
{
  "type": "mcp",
  "name": "finance",                                     // kebab-case, becomes the tool prefix
  "url": "http://finance-mcp.finance-app.svc.cluster.local:8080/mcp",
  "headers": { "X-Example": "value" },                   // optional, default {}
  "tools": ["list_accounts", "get_transaction"],         // optional allowlist; omitted = all discovered
  "timeout_ms": 30000                                    // optional, falls back to IRI_TOOL_CALL_TIMEOUT_MS
}
```

*Why:* per-agent scoping is how every other tool works, and keeping the union as the single place a tool can come from means `runner.ts`, the registration validator, and any future transport all keep one list to walk.

*Consequence, and it is a real one:* this is the first `tools` entry that is **one-to-many**. `api_call` declarations are complete — name, description, parameters all present in the manifest. An `mcp` entry is a *reference*; its tools are unknown until the gateway connects. Registration therefore cannot fully validate an agent's tool surface, and `agent.tools.length` stops being the number of tools the model sees. Everything that walks `agent.tools` must expand first.

*Alternative rejected:* gateway-level env config (`IRI_MCP_FINANCE_URL`) with agents opting in by name. It reads better for a resource no app owns — but finance-app *does* own its MCP server, so the manifest is where knowledge of it actually lives, and this avoids a second parallel configuration mechanism.

*Follow-on:* because URLs now arrive from registering apps, a registration can point the gateway at any host it likes. `IRI_MCP_ALLOWED_ORIGINS` (comma-separated `scheme://host:port`, unset = unrestricted) bounds that. Enforced both at registration and again at connect time, so tightening the allowlist takes effect against manifests already in the store.

### 2. Tools are exposed as `<server>__<tool>`

`finance__list_accounts`, `finance__get_account_balance`, and so on. Under the current SDK runner the model actually sees `mcp__app__finance__list_accounts`, since the gateway's own in-process server is named `app`.

*Why the prefix and not bare names:* collision-free by construction against `api_call` names and against other servers, self-documenting in the transcript, and reversible — the server `name` regex is the agent-id regex (`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`), which excludes `_`, so splitting on the first `__` unambiguously recovers the server.

Validation at registration: the server `name` matches that regex; and since the prefixed name is only known after discovery, at *discovery* time a prefixed name that exceeds 64 characters, fails `^[a-zA-Z0-9_-]+$`, or collides with an `api_call` name on the same agent is dropped with a `warn` rather than failing the run.

### 3. External MCP tools are proxied through the gateway's own in-process MCP server

The Agent SDK can be handed an external MCP server directly (`mcpServers: { finance: { type: "http", url } }`) and would do discovery itself. Not doing that.

*Why:* it would produce zero reusable code — the Responses rewrite deletes the SDK and with it every line of this feature. Proxying instead means `runner.ts` changes by about fifteen lines (expand `mcp` entries before `.map()`, extend `allowedTools`) and everything real lives in `src/agent/mcp/`, transport-agnostic. It also keeps namespacing, the error contract, the origin allowlist, and the tool allowlist under gateway control rather than the SDK's.

*Cost:* one extra in-process hop per tool call, and the gateway re-implements what the SDK would have done. Acceptable at this scale.

### 4. Lazy discovery, in-memory TTL cache, refreshed on the existing background tick

Cache key is the server URL plus a stable serialization of its headers, so the same server declared by two agents shares one entry and one client. Value is the discovered tool list plus `fetched_at`.

- First run needing a server: `initialize` then `tools/list`, cache the result.
- Subsequent runs within `IRI_MCP_CACHE_TTL_MS` (default `300000`, matching `IRI_MANIFEST_CACHE_TTL_MS`): served from cache, no network.
- `startBackgroundRefresh`'s tick, which already walks apps for stale manifests, also re-lists stale MCP entries — same staleness comparison, same `warn`-and-continue failure handling.

*Why lazy over eager-at-boot:* iriguchi's boot must not depend on finance-mcp being up. The chart README already documents restart-ordering pain between these two services; adding a boot-time dependency in the other direction makes it worse.

*Why in-memory and not SQLite:* manifests are persisted because the gateway needs them to answer `/v1/models` and route agents before any app re-registers. A discovered tool list is only needed mid-run and costs one round-trip to rebuild, so persisting it would add a store migration to buy a cold-start optimization nobody asked for.

*Discovery failure is not fatal.* If `tools/list` fails when a run needs it, the gateway logs `warn` with the server name and reason, exposes that server's tools as none, and runs with whatever else the agent has. A run whose only tools were MCP tools proceeds with no tools rather than erroring.

### 5. `@modelcontextprotocol/sdk` with `StreamableHTTPClientTransport`

*Why the SDK over hand-rolled JSON-RPC:* the protocol has a version-negotiation handshake, content-block shapes, and error semantics worth not re-deriving, and a future server on a stateful transport or a different protocol revision is a config change rather than a rewrite. It also gets the `Accept: application/json, text/event-stream` header right by construction — the single most likely thing to trip on here.

*Cost, and the thing to verify first:* the SDK's transport is built for the full streamable-HTTP profile, including an optional `GET` SSE stream. finance-mcp answers `405` to `GET`. The MCP spec requires clients to treat `405` as "this server does not offer SSE" and continue, and the SDK implements that — but this is the highest-risk assumption in the design and **task 1 is a spike that proves it against the real server before anything else is built**. If it does not hold, fall back to hand-rolled JSON-RPC `POST`s behind the same internal interface; the module boundary is drawn so that swap costs one file.

One `Client` is held per cache key and reused across calls. On a transport-level failure the client is disposed and recreated on next use.

### 6. Error mapping — three MCP failure modes into the one existing contract

`tools.ts` becomes a dispatcher on `tool.type`; `invokeApiCallTool` is untouched.

| MCP failure | Returned to the model |
|---|---|
| Transport: connection refused, DNS, socket error | `{ error: { kind: "network", message } }` |
| Transport: exceeded `timeout_ms` | `{ error: { kind: "timeout", message: "request exceeded Nms" } }` |
| Transport: non-2xx HTTP on `POST /mcp` | `{ error: { status, body } }` |
| JSON-RPC error object (`-32601` unknown method, etc.) | `{ error: { kind: "mcp_protocol", code, message } }` |
| Tool result with `isError: true` | `{ error: { kind: "mcp_tool_error", message: <flattened text content> } }` |
| Success | The result's content, text blocks flattened; parsed as JSON when the text parses, else the raw text |

The first three are byte-identical to what `api_call` already produces, which is the point: a model reading a tool result cannot tell which transport failed, and neither can the tests.

**Retry:** once, after 500ms, on transport failure only — mirroring `invokeApiCallTool`'s 5xx/timeout/network retry. Deliberately **not** on `isError`, because the schema does not know a tool is idempotent and finance-mcp's read-only-ness is not a property MCP declares. This matters for a known operational quirk: the first call against a freshly created finance-mcp pod can return `Failed query: select ...` while Neon wakes a cold pool. That arrives as `isError`, so the gateway will not swallow it — the message reaches the model verbatim, which can retry. Flattening tool-error text rather than replacing it with a generic message is what makes that recoverable.

## Risks / Trade-offs

- **The SDK transport may probe `GET /mcp` and choke on `405`** → Task 1 is a spike against the live server, port-forwarded, before any other code. Fallback is a hand-rolled JSON-RPC client behind the same interface, scoped to one file.
- **Registration no longer validates an agent's full tool surface** → A typo'd MCP URL registers fine and fails at run time. Mitigated by validating URL shape and origin at registration, and by logging discovery failures at `warn` with the server name. Accepted: it is inherent to discovery.
- **A slow MCP server adds latency to the first run that touches it** → `timeout_ms` per server declaration, defaulting to `IRI_TOOL_CALL_TIMEOUT_MS`; failure degrades to no-tools rather than a hung run.
- **`listChanged: true` is advertised and ignored** → A tool added to finance-mcp is invisible for up to one TTL. Acceptable; documented as a non-goal.
- **An app can point the gateway at an arbitrary host** → `IRI_MCP_ALLOWED_ORIGINS`, enforced at registration and connect. Unset means unrestricted, which is the current effective posture and keeps existing deployments working.
- **Tool-budget growth** → Six MCP tools plus an agent's `api_call` tools all land in one model context. No cap in this change; the per-server `tools` allowlist is the escape hatch if it bites.
- **Line-level collision with `adopt-openai-responses-api`** → Both rewrite the tool-declaration block in `runner.ts`. Do not implement concurrently; sequence one behind the other.

## Migration Plan

1. Spike the SDK transport against port-forwarded finance-mcp (`kubectl port-forward -n finance-app svc/finance-mcp 8080:8080`, then `http://127.0.0.1:8080/mcp`).
2. Ship the gateway side. No manifest declares an `mcp` entry yet, so behavior is unchanged — schema addition, dispatcher, discovery, and cache are all inert until something opts in.
3. Add the declaration to finance-app's manifest, with the URL from finance-app's own config (`http://finance-mcp.finance-app.svc.cluster.local:8080/mcp` in-cluster, `http://mcp:8080/mcp` under Compose).
4. Homelab: set `IRI_MCP_ALLOWED_ORIGINS` in `apps/iriguchi/`'s non-secret `env:` map. Note the URL itself is *not* iriguchi config under this design — it belongs to finance-app. `~/dev/homelab-randal` has uncommitted finance-mcp chart work in progress; do not clobber it. Rebuild `iriguchi:local`, `helm upgrade`, then restart finance-app after iriguchi, since the app only registers at boot and nothing retries.

Rollback is removing the `mcp` entry from finance-app's manifest and re-registering; the gateway code is inert without it.

## Open Questions

- Should a per-agent or per-server cap on discovered tools exist, or is the optional `tools` allowlist enough? Deferring until a server with a large surface shows up.
- If a second app declares the same MCP server URL with different headers, they get separate cache entries and separate clients. Correct, but untested territory — no scenario requires it today.
