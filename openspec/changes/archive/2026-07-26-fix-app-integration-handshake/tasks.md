## 1. Registration: diagnose the circular manifest auth

- [x] 1.1 Add a `status?: number` field to `ManifestFetchError` in `src/registry/manifest.ts` and populate it on the `!res.ok` path (keep the existing message text).
- [x] 1.2 In `src/routes/registration.ts`, extract the `ManifestFetchError` handling shared by `POST /register` and `POST /:id/refresh-manifest` into one helper that returns `502` with `code: "manifest_unauthorized"` when `status` is `401`/`403`, and today's `code: "app_unavailable"` otherwise.
- [x] 1.3 Write the `manifest_unauthorized` message so it names the cause and the fix: the app token is minted immediately before the manifest fetch, an app cannot know it during initial registration, and `GET /agents-manifest` must accept any non-empty Bearer token while tool endpoints keep exact equality.
- [x] 1.4 Log the rejection at `warn` with `app_id` and the upstream status in both routes.
- [x] 1.5 Add integration tests in `tests/integration/registration.test.ts`: app manifest endpoint returning `401` → `502` + `manifest_unauthorized`; returning `403` → same; returning `500` → `app_unavailable`; timeout/connection failure → `app_unavailable`; schema-invalid body → `app_unavailable`; `refresh-manifest` against a `401` app → `manifest_unauthorized`.
- [x] 1.6 Add a test asserting a contract-conformant app (presence-only Bearer check) registers successfully and receives the same token that was presented on the manifest fetch.

## 2. Chat completions: split SSE formatting from the run

- [x] 2.1 In `src/agent/runner.ts`, rename the generator to `runAgentChunks` yielding `OpenAIChunk` — replace each `yield formatSseChunk(c)` with `yield c` and drop the trailing `DONE_SENTINEL`.
- [x] 2.2 Re-add `runAgentStream` as a thin adapter over `runAgentChunks` that yields `formatSseChunk(c)` per chunk then `DONE_SENTINEL`, preserving its current signature and output byte-for-byte.
- [x] 2.3 Run `tests/integration/runner.test.ts` and `tests/integration/multi-provider-concurrency.test.ts` unchanged to confirm the refactor is behavior-preserving.

## 3. Chat completions: non-streaming response

- [x] 3.1 Add the `ChatCompletion` / `ChatCompletionMessage` types to `src/agent/openai-sse.ts` (`object: "chat.completion"`, single choice, `message.role`/`content`/optional `tool_calls`, `finish_reason`).
- [x] 3.2 Implement `aggregateChunks(chunks: OpenAIChunk[]): ChatCompletion` — concatenate `delta.content` in order, accumulate `delta.tool_calls` by `index`, take `id`/`created`/`model` from the first chunk, take `finish_reason` from the last chunk carrying one (default `"stop"`), default `content` to `""`, omit `tool_calls` when empty.
- [x] 3.3 Unit-test `aggregateChunks` in `tests/unit/openai-sse.test.ts`: multi-chunk concatenation order, empty run → `""`, `finish_reason` passthrough including `"length"`, tool-call accumulation by index, `tool_calls` omitted when none.
- [x] 3.4 In `src/routes/openai.ts`, parse and validate `body.stream`: absent → `false`; boolean → as given; anything else → `400 invalid_request_error` naming the field, before any agent run starts.
- [x] 3.5 Branch the handler — `stream: true` keeps the current eager-probe + SSE path untouched; otherwise drain `runAgentChunks` fully inside the existing `try`/`catch`, call `aggregateChunks`, and return `c.json(completion)` with the `X-Request-Id` header and no streaming headers.
- [x] 3.6 Verify the non-streaming branch maps a mid-run `GatewayError` to its HTTP status and any other error to `500`, both as JSON with `X-Request-Id` — no partial `chat.completion`, no SSE.

## 4. Chat completions: tests

- [x] 4.1 Extend `tests/integration/chat.test.ts` with non-streaming cases: `stream: false` → `application/json` + a valid `chat.completion` whose `content` matches the streamed text for the same run; absent `stream` behaves identically; `id` prefix, `model`, and `X-Request-Id` present.
- [x] 4.2 Add a `stream: "yes"` case asserting `400 invalid_request_error` and that no agent run was started.
- [x] 4.3 Add non-streaming error cases: unknown `iri_agent` → `404 unknown_agent` as JSON; mid-run failure → JSON error with `X-Request-Id`.
- [x] 4.4 Add a non-streaming `iri_show_tool_calls=true` case asserting `message.tool_calls` order, names, and JSON-encoded arguments; and one without the flag asserting `tool_calls` is absent.
- [x] 4.5 Confirm the existing `stream: true` tests still pass unmodified.

## 5. Docs and example

- [x] 5.1 In `docs/app-integration.md` step 1, replace "at minimum check that a Bearer token is present" with a normative statement — the endpoint MUST accept any non-empty Bearer token and MUST NOT compare against the app token — plus a short "why" (the token is minted just before this fetch) and a pointer that tool endpoints do the opposite.
- [x] 5.2 Reword the "authenticates both directions" paragraph (currently `docs/app-integration.md:99-101`) so it no longer implies the manifest fetch is token-checked, and add `manifest_unauthorized` to the failure-modes line.
- [x] 5.3 Document both response modes in `docs/app-integration.md` and `README.md`: `stream: true` → SSE, `stream: false`/absent → `chat.completion` JSON, with a non-streaming request/response example.
- [x] 5.4 Note the breaking default change (absent `stream` is now non-streaming) where the chat endpoint is introduced in `README.md`.
- [x] 5.5 Add a comment in `examples/weather-app/src/server.ts` at the `/agents-manifest` handler stating the presence-only check is deliberate and required by the contract, so it is not "hardened" into exact equality by a future reader.
- [x] 5.6 (added during apply) Tighten `examples/weather-app/src/server.ts` `/api/forecast` to exact app-token equality — it was presence-only, contradicting the tool-endpoint requirement the example is meant to demonstrate.

## 6. Verification

- [x] 6.1 Run the full suite (`bun test`) and confirm no regressions in `tests/integration` or `tests/unit`.
- [x] 6.2 **Deferred — needs credentials.** `tests/e2e/full-flow.test.ts` requires a real `IRI_PROVIDER_ANTHROPIC_API_KEY` and spends tokens; this repo's `.env` configures only local LM Studio, so it cannot run here. Covered instead by 6.4 below, which exercises the same handshake with no LLM.
- [x] 6.4 (added during apply) Add `tests/integration/example-app-handshake.test.ts`: spawns the real weather-app example against a real gateway and asserts registration completes via presence-only manifest auth, the manifest endpoint rejects missing/empty/non-Bearer, it accepts an arbitrary token, and `/api/forecast` accepts only the exact stored app token.
- [x] 6.5 (added during apply) Fix `examples/weather-app/src/server.ts` to resolve its base URL *after* binding. With `WEATHER_PORT=0` it previously registered `base_url: http://localhost:0`, which is unfetchable — a pre-existing bug that also made `tests/e2e/full-flow.test.ts` (which passes `WEATHER_PORT=0`) unable to pass.
- [x] 6.3 Run `openspec validate fix-app-integration-handshake` and resolve any findings.

## 7. Out-of-repo follow-up — `~/dev/finance-app` (outside this change's edit root)

- [x] 7.1 In `src/lib/iriguchi.ts`, add a presence-only helper (non-empty `Bearer ` prefix) and use it in `src/app/agents-manifest/route.ts`; leave `hasIriguchiAppAuthorization` strict and unchanged for the tool routes.
- [x] 7.2 Confirm `/api/ai/category-context` and `/api/ai/category-candidates` still authenticate via `getIriguchiToolUserId` → `hasIriguchiAppAuthorization` (exact equality) and reject any other non-empty token.
- [x] 7.3 Add tests: missing/malformed/empty Bearer on `/agents-manifest` → `401`; any non-empty Bearer → manifest returned; tool endpoints reject a non-empty non-matching token; tool endpoints accept the active rotated token.
- [x] 7.4 Restarted finance-app against the updated gateway; `registerIriguchiApp()` completes and stores a rotated `app_token`. Verified in the gateway log (`app.register` for `finance-app`, agents `[finance-categorizer]`). Uncovered and fixed a second defect the auth deadlock had been masking: `financeAppManifest` did not match the gateway's schema (missing `manifest_version`, flat `id` instead of `app{}`, agents missing `name`/`description`, tools using `input_schema`/`method`/`path` instead of `parameters`/`endpoint{}` and missing `description`). Fixed, with two regression tests.
- [~] 7.5 **Descoped by the user (2026-07-26).** Live LLM verification of `callCategorizerAgent` against LM Studio was skipped. The `stream: false` → JSON path is covered by integration tests in the gateway, but has not been exercised against a real model or through the app's import flow.
