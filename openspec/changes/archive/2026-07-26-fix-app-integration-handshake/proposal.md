## Why

Integrating a real app (finance-app) against the gateway surfaced two blocking defects in the app↔gateway contract:

1. **Registration is circular.** `POST /apps/register` mints a fresh `app_token`, then immediately fetches `{base_url}/agents-manifest` with it — but the app only learns that token when registration *returns*. An app that validates the manifest endpoint by exact-token equality (a reasonable reading of "the gateway presents the app token on every manifest fetch and tool call") rejects the very fetch that would complete registration. The gateway reports this as a generic `502 app_unavailable`, which gives the integrator no way to see the loop they are in.
2. **`stream: false` is ignored.** `POST /v1/chat/completions` always returns `text/event-stream`, even when the request body says `stream: false` or omits `stream` entirely. Every OpenAI-compatible client — including the plain `await response.json()` in finance-app — breaks on this, because in the OpenAI protocol a non-streaming request returns a single `chat.completion` JSON object.

Both are contract bugs at the gateway boundary, and both currently force each integrating app to work around the gateway rather than the reverse.

## What Changes

- **Manifest auth contract is normative, not advisory.** The gateway SHALL specify that `GET /agents-manifest` is authenticated by *presence* of a Bearer token only, and MUST NOT be gated on equality with the active app token — the manifest is public metadata (agent definitions, prompts, schemas, endpoint paths), never app data. Tool endpoints keep strict token equality.
- **Registration diagnoses the loop instead of hiding it.** When the manifest fetch during `POST /apps/register` or `POST /apps/:id/refresh-manifest` fails with `401`/`403`, the gateway returns a distinct `manifest_unauthorized` error code and a message that names the circularity and the fix, instead of a bare `HTTP 401 from …` inside `app_unavailable`.
- **`stream` is honored on `/v1/chat/completions`.** `stream: true` returns SSE exactly as today. `stream: false` — and, per the OpenAI protocol, an absent `stream` — returns a single `chat.completion` JSON object with the aggregated assistant text, `finish_reason`, and (when `iri_show_tool_calls=true`) accumulated `tool_calls`.
  - **BREAKING** for any client that omits `stream` and expects SSE. Every in-repo caller (README, `docs/app-integration.md`, weather-app demo, e2e tests) already sends `stream: true` explicitly, so the blast radius is external clients only.
- **`stream` is validated.** A non-boolean `stream` value is a `400 invalid_request_error` rather than being silently coerced.
- **Docs and example follow the contract.** `docs/app-integration.md` gets an explicit "do not require exact token equality here, and why" callout on the manifest endpoint; the non-streaming request/response shape is documented alongside the streaming one.

Deliberately **not** in scope: teaching clients to parse SSE when they asked for JSON. Fixing `stream: false` at the gateway makes finance-app's existing `await response.json()` correct as written, and fixes every other client at the same time.

## Capabilities

### New Capabilities
- `app-registration`: the registration handshake — token minting order, the manifest-endpoint auth contract apps must implement, provider/id validation, and the failure taxonomy including the circular-auth diagnosis.
- `chat-completions-protocol`: OpenAI-compatible `/v1/chat/completions` request handling — `stream` negotiation, the aggregated non-streaming response shape, and request validation.

### Modified Capabilities
<!-- None. `provider-routing` requirements are unaffected: provider selection, model resolution, and registration-time provider validation all behave identically under both response modes. -->

## Impact

**Code (this repo)**
- `src/routes/openai.ts` — `stream` parsing/validation; branch between SSE body and aggregated JSON body; error paths must return JSON in both modes.
- `src/agent/runner.ts` — expose the chunk stream pre-SSE-formatting (or add an aggregating consumer) so the route can build a `chat.completion` without re-parsing its own SSE text.
- `src/agent/openai-sse.ts` — add the `chat.completion` (non-chunk) shape and an aggregator over `OpenAIChunk[]`.
- `src/routes/registration.ts`, `src/registry/manifest.ts` — surface HTTP status from `ManifestFetchError` so `401`/`403` can be mapped to `manifest_unauthorized`.
- `docs/app-integration.md`, `README.md`, `examples/weather-app/` — contract wording and non-streaming examples.
- Tests: `tests/integration/chat.test.ts`, `tests/integration/registration.test.ts`, `tests/unit/openai-sse.test.ts`.

**Consumers (outside this repo)**
- `~/dev/finance-app` (`src/lib/iriguchi.ts`, `src/app/agents-manifest/route.ts`) must relax its manifest endpoint to a presence-only Bearer check while keeping `hasIriguchiAppAuthorization` strict on `/api/ai/category-context` and `/api/ai/category-candidates`. Tracked as an out-of-repo follow-up in `tasks.md`; edits there are outside this change's allowed edit root.
- Any external client relying on the implicit-SSE behavior must add `stream: true`.
