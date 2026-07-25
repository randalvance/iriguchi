# Iriguchi — Multi-Provider Configuration Design

**Status:** Draft v2 (amended 2026-07-25: per-provider default models; non-Claude models in scope)
**Date:** 2026-06-20
**Owner:** Randal

## Summary

Iriguchi currently talks to a single Anthropic-shaped backend, wired through the fixed env vars `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL`. This spec introduces a named-provider registry so the gateway can route different agents to different Anthropic-shaped backends concurrently — with OpenRouter's Anthropic-compat endpoint as the first non-direct provider.

Scope is deliberately narrow on the wire, not on the model: providers must speak Anthropic `/v1/messages`, but any model served through such a surface is reachable — Claude direct, Kimi via OpenRouter's Anthropic endpoint, or local models via LM Studio's Anthropic-compat server. Non-Anthropic-shaped access (plain OpenAI shape) is explicitly out of scope and deferred.

Each provider carries its own required default model, replacing the single global `IRI_DEFAULT_MODEL` — a global default can only name a model that exists on one provider, which makes it a foot-gun the moment a second provider is configured.

## Goals

- Add a named-provider registry to server config so operators can configure Anthropic direct, OpenRouter (Anthropic endpoint), and future Anthropic-compat backends side by side.
- Let each agent manifest declare which provider it uses via an optional `provider` field.
- Route each chat request to the correct provider without leaking credentials between concurrent requests targeting different providers.
- Reject manifests at register-time when they reference a provider the gateway isn't configured for.
- Give each provider a required default model, so agents (and vanilla requests) that don't pin a model always resolve to something the routed provider actually serves.
- Preserve the current OpenAI-compatible client contract — clients never see providers.

## Non-goals

- OpenAI-shaped providers (real multi-format support). Deferred; will require a different codepath and likely a different SDK or a hand-rolled agent loop.
- Automatic model-name translation across providers. Agent authors write the raw provider-native model string in `default_model`.
- Provider fallback chains (try Anthropic direct; on failure, try OpenRouter). Deferred.
- Per-provider rate limiting, cost tracking, or model allowlists.
- Client-side provider selection (`iri_provider` in request body). Explicitly disallowed — the agent config owns provider selection.
- Backward compatibility with the current `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` env vars. The old vars are removed as part of this change; existing `.env` files must be updated.

## Design decisions (settled during brainstorming)

1. **Provider scope:** Anthropic-shaped endpoint only — but any model behind such an endpoint, not just Claude-family. *(Amended 2026-07-25: originally "Claude-family only." The real constraint is "behaves well behind an Anthropic-shaped, tool-using agent loop"; Kimi and LM Studio-served local models qualify. Residual risk: the Claude Agent SDK's prompting is Claude-tuned — non-Claude models get a per-provider e2e smoke test rather than a scope exclusion.)*
2. **Concurrency:** Multiple providers coexist; per-request routing.
3. **Selection axis:** Agent manifest declares `provider`. Vanilla (no `iri_agent`) requests use the configured default. No client override.
4. **Model naming:** Raw pass-through. Agent authors write `default_model` in the provider-native form (e.g., `moonshotai/kimi-k3` for OpenRouter, `claude-opus-5` for direct Anthropic).
5. **Config shape:** Numbered env vars (`IRI_PROVIDER_<NAME>_*`), matching the existing `IRI_*` env-var convention.
6. **Per-provider default models (2026-07-25):** Every provider requires `IRI_PROVIDER_<NAME>_DEFAULT_MODEL`. The global `IRI_DEFAULT_MODEL` is removed — with per-provider defaults it is a redundant resolution link that can only inject a wrong-provider model name. Reference deployment: `lmstudio` → `ornith-1.0-35b` (default provider), `anthropic` → `claude-opus-5`, `openrouter` → `moonshotai/kimi-k3`.

## Config surface

`Config` type replaces the single-provider fields with a registry:

```ts
type Provider = { name: string; baseUrl: string; apiKey: string; defaultModel: string };
type Config = {
  providers: Record<string, Provider>;   // keyed by lowercased name
  defaultProvider: string;                // must exist in providers
  // ...port, maxAgentTurns, toolCallTimeoutMs,
  // manifestCacheTtlMs, requestTimeoutMs, dbPath, tmpDir,
  // apiKey, registrationSecret — all unchanged
  // NOTE: top-level defaultModel is REMOVED (per-provider defaults replace it)
};
```

`loadConfig(env)`:

1. Scan env for keys matching `^IRI_PROVIDER_([A-Z0-9]+)_(API_KEY|BASE_URL|DEFAULT_MODEL)$`. For each captured name (lowercased — the registry key), all three suffixes must be present. Names are alphanumeric only — no underscores or hyphens — so the env-var suffix boundaries are unambiguous.
2. Any suffix scan may discover a provider name; discovery via any one suffix with the others missing is surfaced as a half-configured error rather than silently ignored.
3. Build `providers[name] = { name, baseUrl, apiKey, defaultModel }`.
4. Validation, in order:
   - At least one provider must be configured, else throw `"no providers configured; set IRI_PROVIDER_<NAME>_API_KEY, IRI_PROVIDER_<NAME>_BASE_URL, and IRI_PROVIDER_<NAME>_DEFAULT_MODEL"`.
   - A provider missing any of the three vars throws `"half-configured provider \"<name>\": missing IRI_PROVIDER_<NAME>_<SUFFIX>"` naming the first missing suffix.
   - `IRI_DEFAULT_PROVIDER` env var, if set, must name a configured provider, else throw.
   - If `IRI_DEFAULT_PROVIDER` is unset and exactly one provider is configured, use it as the default.
   - If `IRI_DEFAULT_PROVIDER` is unset and more than one provider is configured, throw `"multiple providers configured but IRI_DEFAULT_PROVIDER unset; candidates: [a, b, c]"`.
   - `IRI_DEFAULT_MODEL`, if present in the env, throws `"IRI_DEFAULT_MODEL is no longer supported; set IRI_PROVIDER_<NAME>_DEFAULT_MODEL per provider"` — fail loud rather than silently ignore a stale config.

Required env vars going forward: `IRI_API_KEY`, `IRI_REGISTRATION_SECRET`, and at least one complete `IRI_PROVIDER_<NAME>_*` triple. `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, and `IRI_DEFAULT_MODEL` are no longer read.

Example `.env` (reference deployment):

```
IRI_API_KEY=mykey
IRI_REGISTRATION_SECRET=regsecret

# Local LM Studio (Anthropic-compat surface); API key required non-empty but unused
IRI_PROVIDER_LMSTUDIO_API_KEY=lm-studio
IRI_PROVIDER_LMSTUDIO_BASE_URL=http://localhost:1234
IRI_PROVIDER_LMSTUDIO_DEFAULT_MODEL=ornith-1.0-35b

IRI_PROVIDER_ANTHROPIC_API_KEY=sk-ant-...
IRI_PROVIDER_ANTHROPIC_BASE_URL=https://api.anthropic.com
IRI_PROVIDER_ANTHROPIC_DEFAULT_MODEL=claude-opus-5

IRI_PROVIDER_OPENROUTER_API_KEY=sk-or-...
IRI_PROVIDER_OPENROUTER_BASE_URL=https://openrouter.ai/api/v1/anthropic
IRI_PROVIDER_OPENROUTER_DEFAULT_MODEL=moonshotai/kimi-k3

IRI_DEFAULT_PROVIDER=lmstudio
```

## Manifest schema change

`src/registry/schema.ts` adds one optional field to the agent schema:

```ts
provider: z.string().min(1).optional()
```

Semantics: names one of the gateway-configured providers. If omitted, the gateway's `defaultProvider` is used at request time.

Cross-validation between manifests and gateway config happens outside the Zod schema, at register-time and refresh-time (see below). The schema itself only enforces "non-empty string if present."

## Runtime resolution

`runAgentStream` in `src/agent/runner.ts` resolves the provider after the existing agent lookup:

```
providerName = agent?.provider ?? config.defaultProvider
provider     = config.providers[providerName]
if (!provider) throw GatewayError(500, "internal_error", ..., "unknown_provider")
```

Vanilla (no `iri_agent`) requests use `config.defaultProvider`. There is no client override.

### Model resolution

The model chain gains the provider default as its last link, replacing `config.defaultModel`:

```
model = request.model || agent?.default_model || provider.defaultModel
```

Provider resolution happens first and is independent of the model: `request.model` never influences routing (consistent with "clients never see providers"). Two consequences, accepted:

- A vanilla client sending a model the default provider doesn't serve (e.g. `model: claude-opus-5` routed to `lmstudio`) fails at the provider with an upstream error, not a gateway error. Mitigation: `/v1/models` changes to advertise only the default provider's `defaultModel`, so well-behaved clients that pick from the list stay coherent. (The route currently returns `[config.defaultModel, "claude-opus-4-8", "claude-haiku-4-5"]` — the hardcoded Claude ids are wrong the moment the default provider isn't Anthropic, and are dropped.)
- An agent that sets `provider` but omits `default_model` inherits the *routed* provider's default — always a model that provider serves. This is the corner the global default got wrong.

### Credential isolation under concurrency

The current implementation mutates `process.env.ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` around each `query()` call and restores on `finally`. Under a single provider this is a no-op. Under two providers concurrently, request A can flip the env var while request B is mid-`query()` construction — a real race.

Two paths, resolved during implementation:

- **Preferred: SDK options.** If `@anthropic-ai/claude-agent-sdk`'s `query({ prompt, options })` accepts `baseUrl` and `apiKey` on the options object, pass them directly and delete the env-var swap entirely. The first implementation task probes the installed SDK version to confirm.
- **Fallback: serialized env-var swap.** Keep the env-var mutation but wrap the "swap → construct query → capture stream reader" window in a per-process async mutex so only one request is between swap and construction at a time. Streams still run fully concurrently after construction; only the setup window is serialized. Small serialization cost, correct behavior.

The design commits to the preferred path if the SDK supports it, and falls back to the serialized swap if not. Either way, the runner's external contract is unchanged.

## Registration & refresh

`POST /apps/register` and `POST /apps/:id/refresh-manifest` add one validation pass after `manifestSchema.parse`:

```
for each agent in manifest.agents:
  if agent.provider is set and agent.provider not in config.providers:
    reject with 400 invalid_request_error, code=unknown_provider
    message: 'agent "<id>" references unknown provider "<name>"; configured: [<list>]'
```

Registration is atomic (matches existing behavior): a single unknown provider reference rejects the whole manifest — no partial writes.

Background refresh (`src/registry/refresher.ts`) treats the same failure differently: emit a structured warning (`event: "refresh_rejected"`, `reason: "unknown_provider"`, agent id in fields) and keep the previously-cached manifest. This matches the existing stale-on-error policy so an operator who removes a provider without removing dependent agents sees warnings, not silent breakage.

## Error handling

Client-facing error shapes are unchanged. New error codes:

| Where | Status | Type | Code | When |
|---|---|---|---|---|
| Registration route | 400 | `invalid_request_error` | `unknown_provider` | Manifest references a provider not configured on this gateway. |
| Runner (`GatewayError`) | 500 | `internal_error` | `unknown_provider` | Provider disappeared from config between registration and request time. |

Startup errors (missing provider config, half-configured provider, unresolvable default) throw from `loadConfig` and prevent the process from starting.

## Testing

Unit:
- `src/config.ts` — single provider, N providers, no providers rejected, default resolves when unique, default required when N>1, unknown default rejected, half-configured provider rejected (each of the three missing suffixes), name lowercased, stale `IRI_DEFAULT_MODEL` rejected with pointer to the per-provider var.
- `src/routes/openai.ts` — `/v1/models` lists exactly the default provider's `defaultModel`; no hardcoded Claude ids.
- `src/registry/schema.ts` — agent parses with `provider`, without `provider`, empty-string rejected.
- `src/routes/registration.ts` — accepts configured provider, accepts omitted provider, rejects unknown provider (400, `unknown_provider`).
- `src/registry/refresher.ts` — refresh that references a now-unknown provider logs warning and retains prior manifest.
- `src/agent/runner.ts` — agent's `provider` wins over default; vanilla request uses default; runtime unknown-provider throws 500; model chain falls through `request.model` → `agent.default_model` → routed provider's `defaultModel` (in particular: agent with `provider` set but no `default_model` gets that provider's default, not another provider's).

E2E (per-provider smoke):
- One gated smoke per configured provider class (direct Anthropic, OpenRouter/Kimi, LM Studio/local) exercising a tool-calling turn — this is the check that replaced the old "Claude-family only" scope exclusion.

Integration:
- Existing chat integration tests updated to use new env vars via `tests/setup.ts`.
- New concurrency test: register two apps whose agents target two different providers backed by two fake HTTP servers; fire two concurrent chat requests; assert each request landed on the correct fake baseUrl. Catches env-var-swap races.

E2E:
- `tests/e2e/full-flow.test.ts` — swap env-var names, no logical change.

Test setup:
- `tests/setup.ts` provides `IRI_PROVIDER_ANTHROPIC_API_KEY`, `IRI_PROVIDER_ANTHROPIC_BASE_URL`, `IRI_PROVIDER_ANTHROPIC_DEFAULT_MODEL`, `IRI_DEFAULT_PROVIDER=anthropic` as defaults for the whole suite.

## Docs

- `.env.example` — provider block replaces the current `ANTHROPIC_*` block; commented OpenRouter example included.
- `README.md` — new "Providers" section between Quickstart and Generic OpenAI client usage, showing the env-var pattern and how an agent manifest opts into a non-default provider.
- `examples/weather-app/src/manifest.ts` — no change (uses default).

## Rollout

Single PR replacing the current env vars atomically. Consumers of the gateway (including the weather-app demo and E2E harness) update in the same PR. No dual-read window.
