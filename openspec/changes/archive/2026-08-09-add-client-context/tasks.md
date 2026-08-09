## 1. Context module and configuration

- [x] 1.1 Add `maxContextBytes` to `src/config.ts` via `intVar(env, "IRI_MAX_CONTEXT_BYTES", 65536)`, and document the variable in `.env.example`
- [x] 1.2 Create `src/agent/context.ts` exporting `parseClientContext(raw, maxBytes)` returning either the validated object or a `GatewayError`-shaped failure carrying `invalid_context` / `context_too_large`
- [x] 1.3 Implement `summarizeContext(ctx)` in the same module: deterministic top-level walk, scalars as `key: value` truncated at 200 chars, objects/arrays as type+size placeholders, 2000-char block cap, trailing line naming dropped keys
- [x] 1.4 Implement `renderContextBlock(summary)`: untrusted-data frame, delimiter, and escaping of delimiter occurrences within keys and values
- [x] 1.5 Implement `resolveContextPath(ctx, path)` for dot/bracket notation, returning a not-found signal rather than throwing
- [x] 1.6 Unit tests in `tests/unit` covering: shape and size validation and their codes, empty-object handling, scalar truncation, nested placeholder rendering, block cap and dropped-key announcement, byte-identical output for identical input, delimiter escaping, and path resolution including misses

## 2. `when` clause matching

- [x] 2.1 Add the `when` schema to `src/registry/schema.ts` — an optional non-empty record of path to `scalar | scalar[] | {prefix: string} | {exists: boolean}` — on both `ApiCallTool` and `McpServerTool`
- [x] 2.2 Reject an `api_call` tool named `get_context` in manifest validation, surfacing `400` with `code: "reserved_tool_name"` through the registration route
- [x] 2.3 Implement `matchesWhen(when, ctx)` in `src/agent/context.ts`: all entries must hold; absent path fails everything except `{exists: false}`; no-context is the empty object
- [x] 2.4 Unit tests for each matcher form, multi-entry AND semantics, absent-path behavior, the contextless case, and manifest validation of malformed and empty clauses

## 3. Request plumbing

- [x] 3.1 Parse and validate `iri_context` in `src/routes/openai.ts` before the run starts, returning the `400` JSON error in both streaming and non-streaming modes
- [x] 3.2 Thread the validated context onto `ChatRequest` in `src/agent/runner.ts` and through `RunnerOpts`
- [x] 3.3 Log the context's top-level key names and byte size at `info`, and assert in a test that no value appears in emitted log records
- [x] 3.4 Integration tests in `tests/integration` for both response modes: valid context accepted, non-object rejected with `invalid_context`, oversized rejected with `context_too_large`, absent context leaving the response shape unchanged, and unknown-agent `404` still winning

## 4. Prompt injection of the summary

- [x] 4.1 Append the rendered context block last in the system prompt in `runner.ts` when the run carries a non-empty context, leaving the prompt untouched when it does not
- [x] 4.2 Test that the pre-block portion of the system prompt is identical across two requests with different contexts, and that a contextless run's prompt is byte-identical to today's

## 5. The `get_context` tool

- [x] 5.1 Register a `get_context` SDK tool on the `iriguchi-app-tools` server when the run carries a non-empty context, with one optional `path` argument, served from the request context with no app HTTP call
- [x] 5.2 Add `mcp__app__get_context` to `allowedTools` so the permission model does not deny it, and ensure the tool server is created when `get_context` is the only tool
- [x] 5.3 Return an error payload naming the path when it resolves to nothing, without aborting the run
- [x] 5.4 Tests: full payload by default, subtree by path, unresolvable path continues the run, tool absent when there is no context, and the invocation surfacing under `iri_show_tool_calls=true`

## 6. Context-gated tool exposure

- [x] 6.1 Filter `agent.tools` by `matchesWhen` in `runner.ts` **before** `expandAgentTools`, so a gated-out `mcp` entry is never dialed
- [x] 6.2 Log filtered-out tool names at `debug`
- [x] 6.3 Tests: page-scoped tool exposed on its route and hidden elsewhere, `when`-less tools unaffected, contextless request hiding all gated tools, each matcher form, all-entries-must-hold, a gated `mcp` entry producing no connection, and an empty resulting tool set running without error

## 7. End-to-end coverage against the scripted provider

- [x] 7.1 Extend the scripted-provider e2e test with an account-page case: context supplies `route` and `account_id`, the prompt never names the account, and the model's tool call carries the account id from context
- [x] 7.2 Add an import-preview case: a large `rows` payload appears only as a placeholder in the prompt, the model calls `get_context` to read it, and a `when`-gated import tool is exposed on that route and absent on another

## 8. Documentation

- [x] 8.1 Document the `iri_context` envelope, the two-tier delivery, and the page-aware pattern in `docs/app-integration.md`, including the untrusted-data framing and the reserved `get_context` name
- [x] 8.2 Document the `when` clause and its matcher table in the manifest-shape section of `docs/app-integration.md`
- [x] 8.3 Add `IRI_MAX_CONTEXT_BYTES` to the README's configuration section and a short client-side example of sending `iri_context`
- [x] 8.4 Run the full test suite and confirm no existing test changed behavior

## 9. Reference example

- [x] 9.1 Add `save_location` to the weather app's manifest with `when: { route: { prefix: "/city/" } }`, and point the agent's system prompt at the context block
- [x] 9.2 Add `POST /api/locations` (app-token authenticated) and `GET /api/screen` (the app's own front-end read, deliberately not a tool endpoint) to the example server
- [x] 9.3 Send the screen state as `iri_context` from the demo UI, with a city selector and a rendered forecast table so the on-screen payload is visible
- [x] 9.4 Log `get_forecast` calls in the example so the fetch-versus-read-from-context distinction is observable
- [x] 9.5 Document what to try in the example README, mapping each question to the behavior it demonstrates
