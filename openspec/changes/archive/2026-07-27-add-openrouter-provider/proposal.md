## Why

The finance-app categorizer cannot run. Its agent is defined entirely around two `api_call` tools, and the only configured provider — LM Studio serving `ornith-1.0-35b` — cannot serve a request that carries tool definitions. LM Studio derives a tool-call parser by rendering probe conversations through the model's Jinja chat template, and that template aborts with `raise_exception('System message must be at the beginning')`. The request fails at parser generation, before any token is produced. No change to prompt content or ordering on the gateway side can avoid it: the gateway hands the Agent SDK a system prompt and tool definitions, the SDK owns wire serialization, and LM Studio owns template rendering.

The gateway therefore needs a provider that reliably supports tool use. OpenRouter exposes an Anthropic Messages-compatible endpoint (its "Anthropic Skin") at `https://openrouter.ai/api`, which is the same surface the Claude Agent SDK already speaks — so no Anthropic↔OpenAI translation layer is required. `moonshotai/kimi-k3` is a 1M-context model that OpenRouter describes as strong at tool use and long-horizon agentic work.

## What Changes

- **Providers gain a credential style.** OpenRouter's Anthropic surface authenticates via `ANTHROPIC_AUTH_TOKEN` and requires `ANTHROPIC_API_KEY` to be present but **empty** — an unset value makes the SDK fall back to authenticating against Anthropic directly. `src/agent/runner.ts` currently sets only `ANTHROPIC_API_KEY` from `provider.apiKey`, so OpenRouter cannot be configured today. A new optional `IRI_PROVIDER_<NAME>_AUTH_STYLE` (`api_key` | `auth_token`, default `api_key`) selects which variables the runner exports. Existing providers are unaffected.
- **OpenRouter becomes a documented, configurable provider** via the existing three-var triple plus the new auth style, with `moonshotai/kimi-k3` as its default model. No new code path for routing — `provider-routing` already resolves per-agent providers.
- **Tool invocation gets end-to-end verification.** Today nothing proves an agent's `api_call` tools are actually reached: the tool-invoker (`tests/integration/tools.test.ts`) and the SSE translation are tested separately, and the one full-loop test (`tests/e2e/full-flow.test.ts`) is gated behind `IRI_E2E=1` and a real key. A provider-agnostic test will assert that an agent carrying `api_call` tools invokes them, receives results, and folds them into its answer — the exact behavior LM Studio silently could not deliver.
- **Docs and `.env.example`** gain an OpenRouter recipe, including the empty-`ANTHROPIC_API_KEY` requirement and the `moonshotai/kimi-k3` slug (`moonshot/…` is the common 404).

Explicitly **not** in scope: preflight diagnostics for providers that reject tool definitions. That would have turned this debugging session into a clear error message, but it is a separate concern from adding a provider and is deliberately deferred.

## Capabilities

### New Capabilities
- `agent-tool-invocation`: the end-to-end contract that an agent declaring `api_call` tools actually invokes them against whichever provider it is routed to, that results are fed back into the run, and that tool-call visibility behaves consistently — verified without requiring live credentials.

### Modified Capabilities
- `provider-routing`: adds a per-provider credential style, so a provider can be authenticated by bearer/auth-token rather than API key. Existing requirements for the three-var triple, default resolution, and agent-owned provider selection are unchanged.

## Impact

**Code**
- `src/config.ts` — parse `IRI_PROVIDER_<NAME>_AUTH_STYLE`; extend the `Provider` type with `authStyle`; reject unknown values at startup, consistent with existing fail-fast validation.
- `src/agent/runner.ts` — export credentials per the provider's auth style instead of always setting `ANTHROPIC_API_KEY`.
- `tests/unit/config.test.ts`, `tests/integration/runner.test.ts` — auth-style parsing and the env the runner actually exports.
- New provider-agnostic tool-invocation test exercising an agent with `api_call` tools against the fake provider.
- `README.md`, `docs/app-integration.md`, `.env.example` — OpenRouter recipe.

**Operational**
- OpenRouter is a paid, network-dependent provider (`moonshotai/kimi-k3` is listed at $3/$15 per 1M tokens in/out), unlike the current local LM Studio default. Costs are per-run and this is the first provider that spends real money.
- The OpenRouter API key is a new secret in `.env`; it must not reach the repo.
- LM Studio remains configured and can stay the default; per-agent `provider` selection routes only the categorizer to OpenRouter.

**Risks carried into design**
- The Agent SDK may issue auxiliary calls (subagent/summarization models) whose names are not valid OpenRouter slugs.
- Kimi K3's tool-calling is reported as OpenAI-format function calling; it is served through OpenRouter's Anthropic skin, and that translation is the load-bearing assumption of this change.
