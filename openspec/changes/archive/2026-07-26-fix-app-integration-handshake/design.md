## Context

Two defects at the app↔gateway boundary, both found by integrating `~/dev/finance-app`.

**Current registration flow** (`src/routes/registration.ts`): `POST /apps/register` → `generateToken()` → `fetchManifest({ baseUrl, appToken })` → validate → `store.upsertApp` → return `{ app_token, accepted_agents }`. `fetchManifest` (`src/registry/manifest.ts`) collapses every non-2xx into `ManifestFetchError("HTTP ${status} from ${url}")`, and the route maps every `ManifestFetchError` to `502 app_unavailable`. The status code is stringified into the message and then discarded.

`docs/app-integration.md:21` already says "at minimum check that a Bearer token is present" and the weather-app example does exactly that — but "at minimum" reads as a floor, not a ceiling, and the same doc says at line 100 that the token "authenticates both directions… the gateway presents it to *you* on every manifest fetch and tool call." A careful integrator reading both lines implements exact equality, which is what finance-app did (`hasIriguchiAppAuthorization`, a `timingSafeEqual` against `runtimeAppToken ?? process.env.IRIGUCHI_APP_TOKEN`). Initial registration then deadlocks: the app has no token yet, so the fetch is rejected, so registration fails, so the app never gets a token. The gateway reports `502 app_unavailable: HTTP 401 …`, which reads as "your app is down."

**Current chat flow** (`src/routes/openai.ts`): the route parses the body, validates `messages`, calls `runAgentStream`, eager-probes the first chunk so a `GatewayError` can still become an HTTP status, then unconditionally sets `Content-Type: text/event-stream` and pipes the generator. `body.stream` is never read. `runAgentStream` (`src/agent/runner.ts`) is an async generator that yields **already-SSE-formatted strings** — it calls `formatSseChunk` at each of its three yield sites and ends with `DONE_SENTINEL`. So the route has no access to the structured `OpenAIChunk` values it would need to aggregate a `chat.completion`.

Constraints: Bun + Hono; `openspec/config.yaml` sets no extra project rules; edits scoped to `/Users/randal/dev/iriguchi` (the finance-app fix is an out-of-repo follow-up).

## Goals / Non-Goals

**Goals:**
- Make first-time registration succeed against an app that implements the documented contract, and make the failure mode legible when an app does not.
- Make `/v1/chat/completions` honor `stream`, so ordinary OpenAI-compatible clients (`await response.json()`) work unchanged.
- Keep the streaming path byte-identical to today's behavior.
- Keep the app-data boundary strict: only the manifest endpoint relaxes; tool endpoints do not.

**Non-Goals:**
- Redesigning the registration handshake (two-phase registration, pre-shared app tokens, mTLS). The ordering is fine once the contract is stated correctly.
- Teaching clients to parse SSE when they requested JSON. That pushes the gateway's protocol bug onto every integrator.
- Usage/token accounting in the `chat.completion` response. The gateway does not currently surface usage in streaming mode either; adding it is a separate change.
- Supporting `stream_options`, `n > 1`, or multiple choices.

## Decisions

### D1 — Relax the manifest endpoint, not the tool endpoints

Presence-only Bearer on `GET /agents-manifest`; unchanged strict equality on `api_call` tool endpoints.

The manifest is a public capability description: agent ids, system prompts, tool names, JSON schemas, and endpoint paths. It contains no user or business data. Its endpoint is also the *only* one the gateway must call before a shared secret exists. Tool endpoints are the opposite on both counts — they return app data and they are only ever called after registration has completed, when the token is known to both sides. Splitting the two is the smallest change that removes the circularity without widening the data boundary.

*Alternatives considered:*
- **Gateway presents the registration secret on the initial manifest fetch.** The app already holds `IRI_REGISTRATION_SECRET`, so equality checking would work. Rejected: it sends the gateway's most privileged secret to an arbitrary `base_url` supplied in the request body — an SSRF-adjacent credential-exfiltration vector — and it makes the manifest endpoint's auth rule differ between registration and refresh.
- **Two-phase registration**: return the token first, let the app call `refresh-manifest`. Rejected: registration would have to accept apps whose manifests were never validated, so the registry could hold agent-less apps; it also turns a one-request handshake into a three-request one with a partially-registered state to reconcile.
- **Signed fetch (HMAC over the registration secret in a header).** Rejected as over-engineering for metadata that carries no data, and it would require every integrating app to implement signature verification.

### D2 — Diagnose `401`/`403` from the manifest fetch as `manifest_unauthorized`

Add a `status?: number` field to `ManifestFetchError`, populated on the non-2xx path in `fetchManifest`. In both registration routes, `status === 401 || status === 403` maps to `code: "manifest_unauthorized"` with a message that states the ordering and the fix; everything else keeps today's `app_unavailable` message.

Keep the HTTP status at `502` with `type: "app_unavailable"`. The failure genuinely is "the upstream app would not serve us," and clients that branch on the status keep working; the new information rides on `code` and `message`, which is where the taxonomy already lives (`unknown_provider`, `app_unavailable`). Returning `400` instead would be defensible — it *is* a misconfiguration — but it would silently reclassify an existing failure mode.

*Alternative considered:* leave the message alone and only fix the docs. Rejected: the docs were already right-ish and still produced this bug. The error message is what an integrator actually reads at 2am.

### D3 — Split SSE formatting out of `runAgentStream`

Rename the structured generator to `runAgentChunks(...): AsyncGenerator<OpenAIChunk>` — the existing body with `formatSseChunk(c)` replaced by `c`, and no `DONE_SENTINEL`. Keep `runAgentStream` as a thin SSE adapter over it (`formatSseChunk` per chunk, then `DONE_SENTINEL`) so `tests/integration/runner.test.ts` and `multi-provider-concurrency.test.ts`, which collect the string stream, keep passing unchanged.

The route then either pipes `runAgentStream` (streaming, unchanged) or drains `runAgentChunks` through a new `aggregateChunks(chunks: OpenAIChunk[]): ChatCompletion` in `src/agent/openai-sse.ts`.

*Alternative considered:* have the route parse its own SSE text back into objects. Rejected outright — serializing to a wire format and immediately re-parsing it in the same process is the kind of thing that survives for years.

*Alternative considered:* two independent generators. Rejected: duplicates the SDK adaptation and translation logic, which is where the run's real complexity lives.

### D4 — Aggregation is a pure function over chunks

`aggregateChunks` concatenates `delta.content` in order, accumulates `delta.tool_calls` by `index` (each tool call is emitted as a single complete delta today, but accumulating by index is what makes it correct if arguments are ever chunked), takes `id`/`created`/`model` from the first chunk, and takes `finish_reason` from the last chunk that carries one — defaulting to `"stop"`. `content` defaults to `""`, never `null`. `tool_calls` is omitted entirely when empty, so the `iri_show_tool_calls` gate needs no special handling in the aggregator: when the flag is off, `translateSdkEvent` already emits no tool-call deltas.

Being a pure `OpenAIChunk[] → ChatCompletion` function makes it unit-testable in `tests/unit/openai-sse.test.ts` without an agent run, and keeps the streaming and non-streaming responses provably derived from the same event sequence.

### D5 — Absent `stream` means non-streaming

The OpenAI protocol default is `stream: false`, and finance-app's failure is precisely a client assuming that default. Making absent-`stream` stream is the behavior that broke the integration; preserving it as a compatibility shim would keep the gateway subtly non-compliant and would leave a second trap for the next integrator.

This is breaking for external clients that omit `stream` and read SSE, but every in-repo caller — `README.md:79,95`, `docs/app-integration.md:136`, `examples/weather-app/public/index.html:53`, `tests/e2e/*`, `tests/integration/chat.test.ts` — already sends `stream: true` explicitly. The change is called out under **BREAKING** in the proposal and belongs in the release notes.

*Alternative considered:* default absent-`stream` to streaming, honoring only an explicit `stream: false`. Rejected for the reasons above; it would also make the gateway's `/models`-advertised OpenAI compatibility a half-truth.

### D6 — Non-streaming keeps the eager-probe, and extends it to the whole run

Streaming needs the eager first-chunk probe because once headers are sent a `GatewayError` can no longer become a status code. Non-streaming has no such commit point: the entire run is drained before any byte is written, so *any* error — including one raised mid-run — can and SHALL become a JSON error response with the right status. Concretely, the non-streaming branch wraps the whole drain in the existing `try`/`catch` that maps `GatewayError` → status and anything else → `500`, and does not set streaming headers at all.

## Risks / Trade-offs

- **[Breaking: clients omitting `stream` now get JSON]** → Called out as BREAKING in the proposal; README and integration docs gain an explicit non-streaming example so the two modes are visible side by side; no in-repo caller is affected.
- **[Presence-only manifest auth lets any caller with any Bearer token enumerate an app's agents, prompts, and tool paths]** → Accepted and bounded: the manifest is metadata by construction, tool endpoints stay strict, and the requirement is written to keep it that way. An app that considers its prompts sensitive can still IP-allowlist or network-isolate the endpoint; that is a deployment concern, not a protocol one.
- **[Non-streaming buffers the whole run in memory and returns nothing until it completes]** → Inherent to the OpenAI non-streaming contract. Long runs will look like a hang to the client; existing timeouts (`config.requestTimeoutMs`, and the client's own — finance-app uses a 10s `AbortSignal.timeout`) still apply and are the right place to bound it.
- **[Refactoring `runAgentStream` touches the hot path for every existing streaming caller]** → Mitigated by keeping `runAgentStream`'s external signature and output identical, so the existing integration tests are the regression suite; the refactor is a mechanical `yield formatSseChunk(c)` → `yield c` move.
- **[The finance-app half of the fix lives outside this repo's edit root]** → The gateway-side work stands alone and is independently testable; the app-side task is listed explicitly in `tasks.md` as out-of-repo, and the new `manifest_unauthorized` error is what tells any *other* app it needs the same fix.

## Migration Plan

1. Land the gateway changes (registration diagnosis, then `stream` support — independent, either order).
2. Apply the finance-app change in `~/dev/finance-app`: presence-only `GET /agents-manifest`, strict `hasIriguchiAppAuthorization` retained on `/api/ai/category-context` and `/api/ai/category-candidates`.
3. Restart finance-app so `registerIriguchiApp()` runs against the fixed gateway; confirm it stores a rotated `app_token`.
4. Exercise `callCategorizerAgent` — its existing `stream: false` + `await response.json()` now works with no client change.

Rollback: the two gateway changes are independent and separately revertible. Reverting `stream` support restores always-SSE; reverting the diagnosis restores the generic `app_unavailable` message. The finance-app relaxation is compatible with both the old and new gateway, so it does not need to be rolled back in lockstep.

## Open Questions

- Should `chat.completion` responses carry a `usage` block? Omitted here for parity with streaming mode, which does not surface usage either. Worth revisiting as its own change once the SDK's token counts are plumbed through `adaptSdkStream`.
- Should the gateway probe an app's manifest endpoint with a deliberately bogus token at registration time and warn if the app accepts *no* token at all? It would catch the inverse misconfiguration (an unauthenticated manifest endpoint), but it doubles the registration round-trips; deferred.
