## Why

Today the only thing a client can tell the gateway about *where the user is* is whatever they type into the prompt. A user standing on an account page has to say "for the Chase Checking account" every time, and a chat box on an import-preview screen has no way to tell an agent which import batch is on screen — so "infer the categories, source, and target accounts" is unanswerable without the user restating what the app already knows.

Every consuming app will hit this, so it belongs in the gateway as one standard envelope rather than being re-improvised per app (stuffed into system messages, prepended to the user's text, or smuggled through tool arguments).

## What Changes

- **New request field `iri_context`** on `POST /v1/chat/completions`: a free-form JSON object carried alongside `iri_agent`, scoped to the single request. Clients pass whatever describes their current surface — route, screen, selected record ids, a preview payload.
- **Two-tier delivery into the run.** The gateway renders a compact, size-bounded *summary* of the context into the agent's system prompt so the model always knows the surface it is on, and exposes a gateway-owned `get_context` tool that returns the full payload for the turns that actually need the detail. Large payloads (an import preview table) therefore cost tokens only when read.
- **Context-gated tool exposure.** A manifest tool may carry an optional `when` clause matched declaratively against the request context (e.g. `{"route": "/imports/preview"}`). Tools whose `when` does not match are not exposed for that run; tools without `when` are always exposed, so every existing manifest behaves exactly as it does today.
- **No context schema.** `iri_context` is validated only as "a JSON object within the size limit" — apps are not required to declare its shape. `when` matching is therefore best-effort over whatever keys are present: an absent key never matches.
- **Documentation** of the envelope, the `when` clause, and the page-aware pattern in `docs/app-integration.md` and the README.

Not breaking: absent `iri_context` and `when`-less manifests preserve current behavior byte for byte.

## Capabilities

### New Capabilities
- `client-context`: the request-scoped context envelope — how a client supplies it, how the gateway validates and bounds it, how it is summarized into the prompt, and how the `get_context` tool exposes the full payload.

### Modified Capabilities
- `chat-completions-protocol`: `iri_context` becomes an accepted request field with its own validation and `400` semantics, in both streaming and non-streaming modes.
- `agent-tool-invocation`: the exposed tool set for a run becomes a function of the request context via `when`, and `get_context` joins the run's tool surface.
- `app-registration`: manifest tools gain the optional `when` clause, validated at registration so a malformed matcher fails then rather than silently never matching.

## Impact

- **Code**: `src/routes/openai.ts` (parse/validate `iri_context`), `src/agent/runner.ts` (context summary in the system prompt, `get_context` tool, filtering `apiCallTools`/`mcpTools` by `when`), `src/registry/schema.ts` (`when` on `ApiCallTool` and `McpServerTool`), plus a new context module for summarization and matching.
- **API surface**: one additive request field; one reserved tool name (`get_context`) that a manifest can no longer use for an `api_call` tool.
- **Apps**: no change required. Page-awareness is opt-in per client and per tool.
- **Docs**: `docs/app-integration.md`, `README.md`, and the `examples/weather-app` reference if a demonstrating case is cheap to add.
- **Out of scope**: surfacing `when` in the internal API and management UI; per-context provider or model routing; any server-side persistence of context across requests.
