## 1. De-risk the transport

- [x] 1.1 Port-forward the live server (`kubectl port-forward -n finance-app svc/finance-mcp 8080:8080`) and confirm `POST /mcp` `tools/list` returns the six tools with `Content-Type: application/json` and `Accept: application/json, text/event-stream`
- [x] 1.2 Add `@modelcontextprotocol/sdk` to `package.json` and install
- [x] 1.3 Spike: connect a `Client` over `StreamableHTTPClientTransport` to `http://127.0.0.1:8080/mcp`, call `tools/list` and one `tools/call`, and confirm the transport tolerates `405` on `GET /mcp` without erroring — this is the design's highest-risk assumption
- [x] 1.4 If 1.3 fails, record the failure mode and switch to a hand-rolled JSON-RPC `POST` client behind the same internal interface before continuing; do not adapt the rest of the design around it — **not triggered; 1.3 passed, staying on the SDK**

## 2. Manifest schema

- [x] 2.1 Add `McpServerTool` to `src/registry/schema.ts`: `type: "mcp"`, kebab-case `name`, `url`, optional `headers`, `tools` allowlist, and `timeout_ms`; add it to the `ToolSchema` discriminated union
- [x] 2.2 Validate `url` as an absolute `http:`/`https:` URL inside the schema, with an error message naming the field
- [x] 2.3 Fix the compile fan-out from the widened `Tool` type — `runner.ts`, `tools.ts`, and anything else `tsc --noEmit` surfaces
- [x] 2.4 Unit tests in `tests/unit/schema.test.ts`: valid `mcp` entry accepted, underscore/uppercase `name` rejected, relative and unparseable `url` rejected, defaults applied when optional fields are omitted, `api_call` and `mcp` entries coexisting on one agent

## 3. Config

- [x] 3.1 Add `mcpCacheTtlMs` (`IRI_MCP_CACHE_TTL_MS`, default `300000`) and `mcpAllowedOrigins` (`IRI_MCP_ALLOWED_ORIGINS`, comma-separated, unset = unrestricted, parsed to a normalized origin list) to `src/config.ts`
- [x] 3.2 Unit tests in `tests/unit/config.test.ts`: defaults, parsing and normalization of the origin list, and that an empty or unset allowlist means unrestricted

## 4. MCP client module

- [x] 4.1 Create `src/agent/mcp/client.ts`: build a `Client` + `StreamableHTTPClientTransport` for a given URL and headers, with no dependency on `@anthropic-ai/claude-agent-sdk`
- [x] 4.2 Add a client pool keyed by URL plus a stable serialization of headers; reuse across calls and dispose-and-recreate on transport failure
- [x] 4.3 Create `src/agent/mcp/cache.ts`: in-memory tool-list cache on the same key, storing the discovered tools and `fetched_at`, with TTL lookup and an explicit invalidate
- [x] 4.4 Implement `discoverTools(entry, config)`: allowlist-check the origin, connect, `tools/list`, apply the entry's optional `tools` allowlist, and cache — returning an empty list plus a `warn` on any failure rather than throwing
- [x] 4.5 Implement prefixing and validation: expose each tool as `<server>__<tool>`, dropping with a `warn` any whose prefixed name exceeds 64 chars, falls outside `[A-Za-z0-9_-]`, or collides with an `api_call` name on the same agent

## 5. Invocation and error mapping

- [x] 5.1 Create `src/agent/mcp/invoke.ts` with `invokeMcpTool()`: strip the prefix, `tools/call` with the entry's `timeout_ms` (falling back to `IRI_TOOL_CALL_TIMEOUT_MS`), flatten text content, and parse as JSON when parseable
- [x] 5.2 Map failures onto the existing contract exactly as the design's table specifies — `{error:{kind:"network"|"timeout",message}}`, `{error:{status,body}}`, `{error:{kind:"mcp_protocol",code,message}}`, `{error:{kind:"mcp_tool_error",message}}` with the server's text preserved verbatim
- [x] 5.3 Retry once after 500ms on transport failure only; explicitly do not retry `isError` results
- [x] 5.4 Turn `src/agent/tools.ts` into a dispatcher on `tool.type`, leaving `invokeApiCallTool` unmodified and removing the `unsupported tool type` throw for `mcp`

## 6. Runner integration

- [x] 6.1 In `src/agent/runner.ts`, expand `agent.tools` before the `.map()`: `api_call` entries pass through, `mcp` entries resolve to their discovered tools
- [x] 6.2 Build SDK tools for discovered tools using the existing `jsonSchemaToZodRawShape` against each tool's `inputSchema`, unchanged
- [x] 6.3 Extend `allowedTools` to include `mcp__app__<server>__<tool>` for every discovered tool, or every call is denied in headless mode
- [x] 6.4 Confirm the degradation path: a run whose only tools came from a failed server proceeds with no tools and no client-visible error, and attaches no tool server when the expanded list is empty

## 7. Registration and background refresh

- [x] 7.1 Extend manifest validation in the registration path with the MCP checks — `name`, `url`, and origin allowlist — failing with `400` naming agent, entry, and field, without connecting to the server
- [x] 7.2 Re-check the origin allowlist at connect time so a manifest stored before the allowlist tightened is refused
- [x] 7.3 Extend `startBackgroundRefresh`'s tick to re-list stale MCP cache entries, logging `warn` and preserving the previous list on failure

## 8. Tests

- [x] 8.1 Write `tests/helpers/fake-mcp-server.ts` in the style of `fake-anthropic.ts`: an in-process HTTP server answering `initialize`, `tools/list`, and `tools/call`, scriptable to return results, `isError`, JSON-RPC errors, non-2xx, and hangs
- [x] 8.2 Unit tests for error mapping — all five failure shapes plus the parsed-JSON success case
- [x] 8.3 Unit tests for prefixing and collision handling, including two servers advertising the same tool name
- [x] 8.4 Integration test for discovery and caching: one `tools/list` across two runs, one across two agents sharing a URL, re-list after TTL expiry
- [x] 8.5 Integration test for degradation: unreachable server leaves `api_call` tools working; MCP-only agent still answers
- [x] 8.6 Integration test for the full MCP tool loop against the fake server and `fake-anthropic`, asserting each stage distinctly so a break is attributable
- [x] 8.7 Integration tests for registration validation: malformed URL, disallowed origin, and re-registration re-validating
- [x] 8.8 Integration test that the background tick refreshes a stale entry and preserves the old list on failure
- [x] 8.9 `npm test` and `npm run typecheck` clean

## 9. Documentation

- [x] 9.1 Document the `mcp` tool type in the manifest section of `README.md` — fields, defaults, prefixing, and the one-to-many expansion
- [x] 9.2 Document `IRI_MCP_CACHE_TTL_MS` and `IRI_MCP_ALLOWED_ORIGINS`, including that an unset allowlist is unrestricted
- [x] 9.3 Note the non-goals: no auth beyond static headers, `listChanged` not honored, HTTP transport only

## 10. Wire up finance-app end to end

- [ ] 10.1 Add the `mcp` entry to finance-app's manifest, taking the URL from finance-app's own config (`http://finance-mcp.finance-app.svc.cluster.local:8080/mcp` in-cluster, `http://mcp:8080/mcp` under Compose)
- [x] 10.2 Verify locally against the port-forwarded server: an agent run discovers and successfully invokes all six finance tools — **all six discovered and invoked through `expandAgentTools` + `invokeTool` against the live server; the model-in-the-loop leg is covered by `tests/integration/mcp-agent-loop.test.ts` against a scripted provider, since a live run needs a provider credential**
- [ ] 10.3 Add `IRI_MCP_ALLOWED_ORIGINS` to the non-secret `env:` map in `~/dev/homelab-randal/apps/iriguchi/`, leaving the repo's uncommitted finance-mcp chart work untouched
- [ ] 10.4 Rebuild `iriguchi:local`, `helm upgrade`, then restart finance-app after iriguchi so it re-registers — the app registers only at boot and nothing retries
- [ ] 10.5 Confirm in-cluster: run an agent against the deployed gateway and check the six tools resolve; retry once if the first call reports a failed query, which is Neon waking a cold pool
