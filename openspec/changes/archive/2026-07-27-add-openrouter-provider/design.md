## Context

The gateway executes agents through `query()` from `@anthropic-ai/claude-agent-sdk`, pointing it at a provider by exporting `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` into the SDK's environment (`src/agent/runner.ts`). "Anthropic-shaped provider" is therefore the gateway's whole provider abstraction — `config.providers` is a registry of `{name, baseUrl, apiKey, defaultModel}` triples parsed from `IRI_PROVIDER_<NAME>_*` env vars, and `provider-routing` already resolves which one a given agent uses.

The only configured provider is LM Studio, and it cannot serve this workload. Given a request carrying tool definitions, LM Studio attempts to auto-generate a tool-call parser by rendering probe conversations through `ornith-1.0-35b`'s Jinja template; the template calls `raise_exception('System message must be at the beginning')` and the request dies at HTTP 400 before inference begins. Observed as request `01KYF9S59W65Q6JJ53ABRN1DXC`. The finance-app categorizer is defined entirely around two `api_call` tools, so it cannot run at all.

Research findings that constrain this design:
- OpenRouter exposes an Anthropic Messages-compatible endpoint (the "Anthropic Skin") at base URL `https://openrouter.ai/api` — the same surface the SDK speaks. No translation layer is needed.
- That endpoint authenticates via `ANTHROPIC_AUTH_TOKEN`, and OpenRouter's own guidance is explicit that `ANTHROPIC_API_KEY` must be set to an **empty string, not unset** — otherwise the SDK falls back to authenticating against Anthropic directly.
- `moonshotai/kimi-k3` is the correct slug (1M context, $3/$15 per 1M tokens; `moonshot/…` is the common 404), described as strong at tool use and long-horizon agentic work.

## Goals / Non-Goals

**Goals:**
- Make OpenRouter configurable as a provider without special-casing it in the routing code.
- Unblock the categorizer by giving it a provider whose models can actually take tool definitions.
- Close the verification gap that let a total tool-loop failure reach a user as a three-minute hang and a generic 500.
- Keep LM Studio working, unchanged, and available as the default.

**Non-Goals:**
- Preflight probing or richer diagnostics when a provider rejects tool definitions. Deliberately deferred; see Open Questions.
- Anthropic↔OpenAI translation. OpenRouter's Anthropic skin makes it unnecessary, and building it would be the largest piece of work in the alternative design.
- Per-request or client-selected providers. Provider choice stays agent-owned, per `provider-routing`.
- Cost controls, budgets, or usage accounting for a now-billable provider.

## Decisions

### D1 — Model the difference as a per-provider auth style, not an OpenRouter special case

Add optional `IRI_PROVIDER_<NAME>_AUTH_STYLE` ∈ {`api_key`, `auth_token`}, defaulting to `api_key`, and widen `Provider` with `authStyle`. `runner.ts` branches on it when building the SDK env.

The gateway's provider abstraction is "an Anthropic-shaped endpoint plus a credential." OpenRouter fits that abstraction; it differs only in *which header* carries the credential. Encoding that as a named provider ("if name === 'openrouter'") would put a vendor name in the routing code and would not help the next Anthropic-compatible gateway that uses bearer auth. A two-value enum keeps the config surface honest about what actually varies.

*Alternatives considered:*
- **Always export both `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY`.** Tempting — one code path, no config. Rejected: it would send the credential in two forms to every provider including local ones, and blanking `ANTHROPIC_API_KEY` for Anthropic-direct providers would break them. Silently sending a key to a header a provider does not expect is a credential-leak shape, not a convenience.
- **A free-form `AUTH_HEADER` name.** More general, but invites typos that fail at request time rather than startup, and the SDK only honors these two variables anyway. A closed enum fails fast.
- **Wrap OpenRouter in a local shim that rewrites headers.** Adds a process to run and monitor for a difference that is one env var wide.

### D2 — `ANTHROPIC_API_KEY` is exported as an empty string, and that is load-bearing

For `auth_token` providers the runner sets `ANTHROPIC_API_KEY: ""` rather than omitting it. This is the single most fragile detail in the change: an omitted variable does not fail loudly, it makes the SDK authenticate against Anthropic directly — a wrong-endpoint, wrong-bill, possibly-succeeding request that looks like success. `runner.ts` spreads `...process.env` into the SDK env, so an operator's ambient `ANTHROPIC_API_KEY` would otherwise leak in and take effect.

The spec pins this with its own scenario ("Empty key is present, not absent") and the tests assert on key presence, not just value, because `expect(env.ANTHROPIC_API_KEY).toBeFalsy()` passes for both the correct and the dangerous case.

### D3 — Keep LM Studio as default; route only the categorizer via the agent manifest

No change to `defaultProvider`. finance-app's manifest sets `provider: "openrouter"` on the `finance-categorizer` agent, which `provider-routing` already honors ("Agent provider wins over default"), and registration already rejects manifests naming unconfigured providers.

This keeps the blast radius at one agent and keeps spend opt-in per agent rather than global. It also means the gateway can be run with no OpenRouter key at all — the provider simply is not configured, and the existing `unknown_provider` validation rejects the manifest at registration with a clear message.

*Alternative considered:* make OpenRouter the default provider. Rejected: it would silently move every existing agent, including vanilla no-agent chat requests, onto a paid network provider.

### D4 — Verify the tool loop against a scripted provider, not a live one

The new test drives the full loop — agent with `api_call` tools → scripted provider emits a `tool_use` → gateway calls the app endpoint → result returns → provider emits final text — using the existing `spinUpFakeAnthropic` helper, which already supports multi-response scripting (`responses: [[tool_use], [text]]`), plus a Hono stub app.

The point is to make the *gateway's* half of the loop non-optional in CI. It cannot prove any particular model will elect to call a tool — that is a model property, and the LM Studio failure was a provider property. What it proves is that when a model does emit a tool call, every subsequent stage works. That is precisely the part that no unskippable test covers today: `tests/integration/tools.test.ts` tests the invoker in isolation and `tests/e2e/full-flow.test.ts` needs `IRI_E2E=1` and a real key.

*Alternative considered:* a live smoke test against OpenRouter. Rejected as the primary verification — it spends money, needs a secret, and is unavailable in CI — though `tests/e2e/provider-smoke.test.ts` is the right home for an opt-in one.

### D5 — Model names pass through untranslated

`model` continues to flow from the agent's `default_model`, the request, or the provider's `defaultModel` straight into the SDK, unvalidated. For OpenRouter that means callers write OpenRouter slugs (`moonshotai/kimi-k3`), matching the existing pass-through rule already documented in the README.

Validating slugs would mean fetching and caching OpenRouter's model list and inventing a per-provider validation hook — real work for an error the provider already reports clearly.

## Risks / Trade-offs

- **[The SDK may make auxiliary calls with model names OpenRouter cannot resolve]** — the Agent SDK can invoke secondary models (subagents, summarization) whose names come from its own defaults, not from `sdkOptions.model`. Against OpenRouter those would be unresolvable slugs. → The tool-loop test will not catch this, since it uses a scripted provider. The opt-in live smoke test is what surfaces it; if it bites, the fix is exporting `ANTHROPIC_DEFAULT_*_MODEL` / `CLAUDE_CODE_SUBAGENT_MODEL` alongside the credential, which is a natural extension of the same env-building code.
- **[Kimi K3's tool calling is documented as OpenAI-format function calling, reached here through OpenRouter's Anthropic skin]** — the skin's tool translation is the load-bearing assumption of this change, and it is exactly the layer that failed with LM Studio. → Not verifiable from a scripted test; requires one live run. This is the change's main residual risk and the reason a live smoke test is included as an opt-in task rather than dropped.
- **[First provider that spends real money]** — a runaway agent loop now has a bill attached, bounded only by `IRI_MAX_AGENT_TURNS`. → Out of scope to solve, but worth stating: keep the default provider local, and treat per-agent opt-in as the cost boundary.
- **[New secret in `.env`]** — an OpenRouter key sits beside the existing dev-value secrets. → `.env` is already gitignored; `.env.example` carries a placeholder only.
- **[Empty-string `ANTHROPIC_API_KEY` is easy to "clean up" later]** — a future reader may see `ANTHROPIC_API_KEY: ""` as dead code. → Comment at the assignment plus a dedicated spec scenario and test asserting presence.

## Migration Plan

1. Land config + runner changes; existing providers keep `api_key` style with no config change and no behavior change.
2. Add the OpenRouter triple plus `IRI_PROVIDER_OPENROUTER_AUTH_STYLE=auth_token` to `.env`; restart the gateway (env changes are not picked up by `--hot`).
3. Set `provider: "openrouter"` and `default_model: "moonshotai/kimi-k3"` on finance-app's `finance-categorizer` agent, then re-register so the gateway stores the updated manifest.
4. Run the import flow and confirm the agent invokes `get_category_context` / `get_category_candidates`.

Rollback: remove the OpenRouter env vars and drop `provider` from the agent manifest. The auth-style code is inert without a provider configured to use it, so it need not be reverted.

## Open Questions

- Should a provider that rejects tool definitions fail fast with a legible error instead of surfacing as `request.unhandled_error` after a multi-minute retry? Deferred by scope, but this session's failure took ~3 minutes to report `Claude Code returned an error result` with the real cause buried in a nested JSON string. It is the natural follow-up change.
- Should the gateway pin the SDK's auxiliary model names per provider, or leave them to the SDK's defaults until something breaks?
- Does `moonshotai/kimi-k3` need `default_model` set on the agent, or should the OpenRouter provider's `defaultModel` carry it? The latter is simpler but makes every OpenRouter-routed agent inherit Kimi; the former is explicit. Currently written as provider-level default with agent-level override available.
