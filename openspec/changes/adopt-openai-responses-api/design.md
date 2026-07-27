## Context

The gateway currently has one execution path: `src/routes/openai.ts` validates an OpenAI Chat Completions request, `src/agent/runner.ts` calls `query()` from `@anthropic-ai/claude-agent-sdk`, and the SDK does the real work — it owns the conversation loop, tool orchestration (app `api_call` tools are wrapped as an in-process MCP server), turn bounding via `maxTurns`, skills materialization, retries, and the provider call itself. The gateway steers it by exporting `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` into the SDK's environment and adapts the SDK's event stream into OpenAI chunks via `translateSdkEvent`.

That design makes "Anthropic-shaped provider" the gateway's provider abstraction. It is also why a model whose chat template could not survive LM Studio's tool-parser generation took the categorizer down entirely, surfacing as `request.unhandled_error: Claude Code returned an error result` after a multi-minute retry, with the real cause nested inside a stringified JSON body.

Moving both surfaces to the Responses API changes what the gateway *is*: from a translator wrapped around an agent framework, to an agent loop of its own with a Responses surface on both sides. Confirmed constraints:
- OpenRouter serves `POST /v1/responses` (beta) at `https://openrouter.ai/api/v1/responses`.
- It is stateless: `store: true` or a non-null `previous_response_id` are rejected with `400`.

## Goals / Non-Goals

**Goals:**
- Accept the Responses request shape from clients and speak it to providers.
- Own the agent loop, so tool orchestration and turn bounding are the gateway's behavior and are testable as such.
- Keep `/v1/chat/completions` working byte-for-byte for existing clients.
- Make provider failures attributable — which provider, which status, which message.

**Non-Goals:**
- Statefulness. No `store`, no `previous_response_id`, no response retrieval endpoints. The provider rejects these and the gateway is stateless by design; adding persistence would be a separate change with its own retention and privacy questions.
- Reasoning-item passthrough, web search, and other provider-native tool types. Only `function` tools backed by app `api_call` declarations are in scope.
- Multi-provider fallback or routing policy. Provider choice stays agent-owned.
- Preserving Claude Code-specific features that have no Responses equivalent (see D4).

## Decisions

### D1 — Remove the Agent SDK rather than adapt around it

The SDK cannot target a Responses endpoint, so keeping it would mean running Anthropic-shaped and Responses-shaped paths side by side, with tool orchestration implemented twice and two sets of failure modes. The loop the SDK provides is, for this gateway's purposes, small: send a request, execute any returned function calls, send the results back, stop at a bound. What the SDK adds beyond that — permissions, subagents, skills — the gateway either does not use or cannot carry over.

The honest cost is that retries, backoff, and a well-tested conversation loop become the gateway's problem. That is accepted deliberately: the current arrangement means the gateway cannot explain its own failures, because the loop is a black box behind an error string.

*Alternatives considered:*
- **Keep the SDK for Anthropic-shaped providers, add a Responses path alongside.** Rejected: two execution paths, doubled tool-orchestration code, and every integration test written twice. The `provider-routing` abstraction would have to grow a shape discriminator that leaks into every layer.
- **Put a translating proxy in front of Responses providers** so the SDK still sees Anthropic Messages. Rejected: it moves the hardest part — tool-call translation — into a component with no visibility to the gateway, which is exactly the opacity that made the LM Studio failure expensive to diagnose.

### D2 — One loop, two surfaces; chat-completions becomes an adapter

The loop is defined over Responses input items and returns the run's items. `/v1/responses` serializes them directly. `/v1/chat/completions` translates `messages` into input items on the way in and folds the result back into `chat.completion` shapes on the way out, reusing the existing `aggregateChunks`-style aggregation for the non-streaming body.

This keeps exactly one place where tool calls are executed and turns are counted. It also makes the equivalence testable in a way that would otherwise be assumed: the same agent and input through both surfaces must produce the same assistant text, which is a spec scenario rather than an aspiration.

*Alternative considered:* deprecate `/v1/chat/completions` outright. Rejected — finance-app calls it today, the weather-app browser demo parses its SSE, and the change is already large enough without a client migration in the middle of it.

### D3 — Statelessness is a first-class requirement, not an omission

The gateway rejects `store: true` and `previous_response_id` with `400` rather than silently ignoring them. A client that believes the server is storing conversation state and is wrong will send truncated input and get subtly degraded answers — a failure that looks like a bad model rather than a protocol mismatch. Rejecting loudly matches OpenRouter's own behavior, so the constraint is inherited rather than invented.

### D4 — Skills are a known casualty, and the schema must stop promising them

`ManifestSchema` accepts `skills` with inline content or a URL, and `materializeSkills` writes them to a working directory for Claude Code to pick up. A Responses provider has no such concept. The options are to drop `skills` from the manifest schema, or to inline skill content into `instructions`.

Recommendation: **inline into `instructions`**, because it preserves the manifest contract for apps that declare skills and degrades predictably, whereas removing the field breaks manifests atomically at registration. Either way the schema must stop advertising a capability the runtime cannot honor. No app currently ships skills — both the weather-app and finance-app manifests declare `skills: []` — so this can be decided on merit rather than under migration pressure. Flagged in Open Questions because it is a contract change that outlives this refactor.

### D5 — Tool calls are executed by the gateway, and undeclared calls are refused locally

`api_call` tools become Responses `function` declarations carrying the manifest's `name`, `description`, and `parameters`. When the provider returns `function_call` items, the gateway matches each against the agent's declared tools, invokes the app via the existing `invokeApiCallTool` (which already handles auth, timeouts, and one retry), and appends `function_call_output` items keyed by call id.

A function name the agent does not declare is refused without an outbound request. Under the SDK this was implicit — the MCP server only exposed declared tools. Once the gateway builds requests itself, a hallucinated or stale tool name is a plausible way to induce an unintended request against the app, so the check becomes explicit and specified.

### D6 — Provider errors are classified at the boundary

The loop distinguishes provider rejection (non-2xx with a body) from transport failure (refused, timeout), and preserves the provider's status and message in a structured error rather than collapsing to `internal_error`. This is the direct lesson of the LM Studio incident: the actionable detail existed, and the gateway threw it away.

## Risks / Trade-offs

- **[Reimplementing the loop reintroduces solved problems]** — retries, backoff, partial-failure handling, and streaming reassembly are easy to get subtly wrong. → Scope is narrow (function tools only, no reasoning items, no state), and the loop's behavior is pinned by scenarios in `agent-loop-transport` including multi-call turns, tool failure, and the turn bound.
- **[Every existing runner and chat test is rewritten]** — `tests/helpers/fake-anthropic.ts` scripts an Anthropic SSE stream and becomes useless; the tests built on it are the current regression suite for streaming, aggregation, and multi-provider isolation. → Build the scripted Responses provider helper first and port tests to it before touching `runner.ts`, so the suite stays meaningful throughout rather than going dark mid-change.
- **[`/v1/chat/completions` regressions are invisible without cross-surface tests]** — the adapter can drift from the behavior its spec promises. → The equivalence scenario is a required test, not a comment.
- **[Responses on OpenRouter is beta]** — the contract may shift, and the beta may not expose everything the docs suggest. → Only the narrow subset above is used; the surface the gateway relies on is small and mostly stable across implementations.
- **[Provider-native tool types and reasoning items are ignored]** — a provider may return item types the loop does not model. → Unknown output items must be tolerated and passed through or dropped without failing the run; a strict parser here would make every provider-side addition an outage.
- **[Large change with no intermediate shipping point]** — the gateway is either on the SDK or off it. → Sequence deliberately: helper, then loop behind the existing surface, then the new surface, then SDK removal. Each step keeps the suite green.

## Migration Plan

1. Build the scripted Responses provider test helper; port the existing runner/chat tests onto it where they assert surface behavior rather than SDK internals.
2. Implement the loop and switch `/v1/chat/completions` onto it. At this point the surface is unchanged and the existing tests are the proof.
3. Add `POST /v1/responses` and its streaming events.
4. Remove `@anthropic-ai/claude-agent-sdk`, `materializeSkills`, and the fake-Anthropic helper; resolve the skills decision from D4.
5. Reconfigure providers as Responses endpoints; drop the auth-style mechanism introduced by `add-openrouter-provider`.

Rollback: steps 1–3 are additive and independently revertible. Step 4 is the point of no return — the SDK dependency is gone and provider config changes shape. Do not take step 4 until a live run against a real Responses provider has exercised the tool loop.

## Open Questions

- **Skills:** inline into `instructions`, or remove from the manifest schema? D4 recommends inlining; it is a manifest contract change either way and deserves an explicit decision before step 4.
- Should `/v1/responses` expose `GET /v1/responses/:id` returning `404` for every id, so clients that probe for statefulness get a clear answer rather than a route miss?
- Should the loop cap total tool invocations in addition to provider round trips? `IRI_MAX_AGENT_TURNS` bounds turns, but a single turn returning many `function_call` items is unbounded in app requests.
- Does anything depend on the gateway's current retry behavior, which comes from the SDK and disappears with it?
