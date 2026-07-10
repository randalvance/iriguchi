# Iriguchi — Multi-Provider Configuration Design

**Status:** Draft v1
**Date:** 2026-06-20
**Owner:** Randal

## Summary

Iriguchi currently talks to a single Anthropic-shaped backend, wired through the fixed env vars `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL`. This spec introduces a named-provider registry so the gateway can route different agents to different Anthropic-shaped backends concurrently — with OpenRouter's Anthropic-compat endpoint as the first non-direct provider.

Scope is deliberately narrow: providers must speak Anthropic `/v1/messages`. Only Claude-family models (or Anthropic-compat proxies of them) are reachable. Non-Anthropic-shaped access (GPT, Gemini, plain OpenAI shape) is explicitly out of scope and deferred.

## Goals

- Add a named-provider registry to server config so operators can configure Anthropic direct, OpenRouter (Anthropic endpoint), and future Anthropic-compat backends side by side.
- Let each agent manifest declare which provider it uses via an optional `provider` field.
- Route each chat request to the correct provider without leaking credentials between concurrent requests targeting different providers.
- Reject manifests at register-time when they reference a provider the gateway isn't configured for.
- Preserve the current OpenAI-compatible client contract — clients never see providers.

## Non-goals

- OpenAI-shaped providers (real multi-format support). Deferred; will require a different codepath and likely a different SDK or a hand-rolled agent loop.
- Automatic model-name translation across providers. Agent authors write the raw provider-native model string in `default_model`.
- Provider fallback chains (try Anthropic direct; on failure, try OpenRouter). Deferred.
- Per-provider rate limiting, cost tracking, or model allowlists.
- Client-side provider selection (`iri_provider` in request body). Explicitly disallowed — the agent config owns provider selection.
- Backward compatibility with the current `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` env vars. The old vars are removed as part of this change; existing `.env` files must be updated.

## Design decisions (settled during brainstorming)

1. **OpenRouter scope:** Anthropic-shaped endpoint only. Only Claude-family models.
2. **Concurrency:** Multiple providers coexist; per-request routing.
3. **Selection axis:** Agent manifest declares `provider`. Vanilla (no `iri_agent`) requests use the configured default. No client override.
4. **Model naming:** Raw pass-through. Agent authors write `default_model` in the provider-native form (e.g., `anthropic/claude-sonnet-4.5` for OpenRouter, `claude-sonnet-4-6` for direct Anthropic).
5. **Config shape:** Numbered env vars (`IRI_PROVIDER_<NAME>_*`), matching the existing `IRI_*` env-var convention.

## Config surface

`Config` type replaces the single-provider fields with a registry:

```ts
type Provider = { name: string; baseUrl: string; apiKey: string };
type Config = {
  providers: Record<string, Provider>;   // keyed by lowercased name
  defaultProvider: string;                // must exist in providers
  // ...port, defaultModel, maxAgentTurns, toolCallTimeoutMs,
  // manifestCacheTtlMs, requestTimeoutMs, dbPath, tmpDir,
  // apiKey, registrationSecret — all unchanged
};
```

`loadConfig(env)`:

1. Scan env for keys matching `^IRI_PROVIDER_([A-Z0-9]+)_API_KEY$`. For each match, lowercase the captured name (the registry key) and look up the matching `IRI_PROVIDER_<UPPERCASE_NAME>_BASE_URL`. Names are alphanumeric only — no underscores or hyphens — so the env-var suffix boundaries are unambiguous.
2. Also scan for `^IRI_PROVIDER_([A-Z0-9]+)_BASE_URL$` to catch base URLs whose corresponding `_API_KEY` is missing (surfaced as a half-configured error rather than silently ignored).
3. Build `providers[name] = { name, baseUrl, apiKey }`.
4. Validation, in order:
   - At least one provider must be configured, else throw `"no providers configured; set IRI_PROVIDER_<NAME>_API_KEY and IRI_PROVIDER_<NAME>_BASE_URL"`.
   - A `IRI_PROVIDER_<NAME>_API_KEY` without a `IRI_PROVIDER_<NAME>_BASE_URL` (or vice versa) throws `"half-configured provider \"<name>\": missing IRI_PROVIDER_<NAME>_BASE_URL"` (or the API_KEY variant).
   - `IRI_DEFAULT_PROVIDER` env var, if set, must name a configured provider, else throw.
   - If `IRI_DEFAULT_PROVIDER` is unset and exactly one provider is configured, use it as the default.
   - If `IRI_DEFAULT_PROVIDER` is unset and more than one provider is configured, throw `"multiple providers configured but IRI_DEFAULT_PROVIDER unset; candidates: [a, b, c]"`.

Required env vars going forward: `IRI_API_KEY`, `IRI_REGISTRATION_SECRET`, and at least one complete `IRI_PROVIDER_<NAME>_*` pair. `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` are no longer read.

Example `.env`:

```
IRI_API_KEY=mykey
IRI_REGISTRATION_SECRET=regsecret

IRI_PROVIDER_ANTHROPIC_API_KEY=sk-ant-...
IRI_PROVIDER_ANTHROPIC_BASE_URL=https://api.anthropic.com

IRI_PROVIDER_OPENROUTER_API_KEY=sk-or-...
IRI_PROVIDER_OPENROUTER_BASE_URL=https://openrouter.ai/api/v1/anthropic

IRI_DEFAULT_PROVIDER=anthropic
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
- `src/config.ts` — single provider, N providers, no providers rejected, default resolves when unique, default required when N>1, unknown default rejected, half-configured provider rejected, name lowercased.
- `src/registry/schema.ts` — agent parses with `provider`, without `provider`, empty-string rejected.
- `src/routes/registration.ts` — accepts configured provider, accepts omitted provider, rejects unknown provider (400, `unknown_provider`).
- `src/registry/refresher.ts` — refresh that references a now-unknown provider logs warning and retains prior manifest.
- `src/agent/runner.ts` — agent's `provider` wins over default; vanilla request uses default; runtime unknown-provider throws 500.

Integration:
- Existing chat integration tests updated to use new env vars via `tests/setup.ts`.
- New concurrency test: register two apps whose agents target two different providers backed by two fake HTTP servers; fire two concurrent chat requests; assert each request landed on the correct fake baseUrl. Catches env-var-swap races.

E2E:
- `tests/e2e/full-flow.test.ts` — swap env-var names, no logical change.

Test setup:
- `tests/setup.ts` provides `IRI_PROVIDER_ANTHROPIC_API_KEY`, `IRI_PROVIDER_ANTHROPIC_BASE_URL`, `IRI_DEFAULT_PROVIDER=anthropic` as defaults for the whole suite.

## Docs

- `.env.example` — provider block replaces the current `ANTHROPIC_*` block; commented OpenRouter example included.
- `README.md` — new "Providers" section between Quickstart and Generic OpenAI client usage, showing the env-var pattern and how an agent manifest opts into a non-default provider.
- `examples/weather-app/src/manifest.ts` — no change (uses default).

## Rollout

Single PR replacing the current env vars atomically. Consumers of the gateway (including the weather-app demo and E2E harness) update in the same PR. No dual-read window.
