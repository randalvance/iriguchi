## Why

The gateway speaks two obsolete-facing protocols. Clients call `POST /v1/chat/completions`, OpenAI's previous-generation surface; the Responses API is where OpenAI's tool calling, reasoning, and multi-turn semantics now live, and it is what current SDKs target. On the provider side the gateway is locked to Anthropic-shaped endpoints because it runs agents through `@anthropic-ai/claude-agent-sdk`, which only speaks Anthropic Messages — that single dependency is why LM Studio's template incompatibility could break the categorizer outright, and why reaching any non-Anthropic model requires finding a vendor's Anthropic-compatibility shim rather than calling the vendor directly.

Moving both ends to the Responses API removes the shim hunt: OpenRouter serves `POST /v1/responses` directly, and the same request shape the gateway accepts from clients is close to the one it sends to providers. It also makes the gateway's advertised OpenAI compatibility true of the API people actually build against today.

## What Changes

- **New client-facing surface.** `POST /v1/responses` accepting `model`, `input` (string or item array), `instructions`, `tools`, `stream`, `max_output_tokens`, and `iri_agent`; returning a `response` object whose `output` is an array of typed items. Streaming emits typed Responses events (`response.created`, `response.output_text.delta`, `response.completed`, …) rather than `chat.completion.chunk`.
- **Stateless, and explicit about it.** `store: true` or a non-null `previous_response_id` SHALL be rejected with `400`. This mirrors OpenRouter's own Responses behavior and preserves the gateway's existing stateless contract — clients send full input each turn. No new persistence.
- **The gateway owns the agent loop.** `@anthropic-ai/claude-agent-sdk` is replaced by a loop the gateway runs itself: build a Responses request, call the provider, and while the output contains `function_call` items, invoke the owning app's `api_call` endpoints and feed `function_call_output` items back, bounded by `IRI_MAX_AGENT_TURNS`.
- **Providers become Responses-shaped.** `provider.baseUrl` points at a Responses endpoint and the credential is sent as a plain `Authorization: Bearer`. The `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` env-export mechanism disappears, and with it the need for a per-provider auth style.
- **`/v1/chat/completions` is retained and reimplemented** on top of the new transport, so existing clients — including finance-app today — keep working unchanged. It becomes an adapter over the Responses loop rather than a separate path.
- **BREAKING for manifests using `skills`.** Agent `skills` are materialized on disk for the Claude Code runtime (`src/agent/skills.ts`); a Responses provider has no equivalent concept. See Impact.

## Capabilities

### New Capabilities
- `responses-api-surface`: the client-facing `POST /v1/responses` contract — request validation, the `response` object and its output items, typed streaming events, statelessness, and how `iri_agent` selects an agent.
- `agent-loop-transport`: the gateway-owned multi-turn loop against a Responses provider — request construction, `function_call` handling, turn bounding, and error classification, independent of which surface the client used.

### Modified Capabilities
- `provider-routing`: providers are Responses-shaped rather than Anthropic-shaped; the credential is presented as a bearer token to the provider rather than exported as `ANTHROPIC_API_KEY` into a subprocess environment.
- `chat-completions-protocol`: the endpoint's externally-observable behavior is preserved, but it is redefined as an adapter over the Responses loop; the `stream` negotiation and aggregation rules carry over unchanged.

## Impact

**Code**
- New `src/routes/responses.ts` and a Responses event/type module; `src/routes/openai.ts` becomes an adapter.
- `src/agent/runner.ts` rewritten around the new loop; `src/agent/openai-sse.ts` gains Responses event formatting alongside the existing chunk translation.
- `src/agent/tools.ts` reused as-is for app calls, but tool *declaration* changes: `api_call` tools map to Responses `function` tools instead of MCP tools.
- `src/config.ts` — provider fields lose their Anthropic framing.
- `package.json` — `@anthropic-ai/claude-agent-sdk` removed.
- `tests/helpers/fake-anthropic.ts` is superseded by a scripted Responses provider helper; every runner/chat integration test is rewritten against it.

**Capability regression: skills**
`ManifestSchema` allows agents to declare `skills` with inline content or a URL, materialized into a working directory for Claude Code. Nothing in the Responses API corresponds to this. Either skills are dropped from the manifest schema (breaking any manifest that uses them) or their content is inlined into `instructions` as a degraded substitute. No app currently ships skills — the weather-app and finance-app manifests both declare `skills: []` — so the practical blast radius today is zero, but the schema promises a feature the new runtime cannot honor.

**Also lost with the SDK:** the agent permission model, subagents, and automatic retry/backoff behavior. Turn bounding must be reimplemented; it currently comes free via `maxTurns`.

**Consumers**
- finance-app's `callCategorizerAgent` may stay on `/v1/chat/completions` indefinitely, or move to `/v1/responses`; both are supported.
- The weather-app example's browser client reads `chat.completion.chunk` SSE and is unaffected.

**Relationship to `add-openrouter-provider`**
That change adds a per-provider auth style so the Agent SDK can authenticate against OpenRouter's Anthropic skin. This change removes the SDK and therefore that mechanism. Its config work is superseded; its `agent-tool-invocation` verification and its OpenRouter documentation remain valuable and should be carried forward. Sequencing them as separate changes is deliberate — the smaller one unblocks the categorizer now — but roughly half of it is knowingly temporary.
