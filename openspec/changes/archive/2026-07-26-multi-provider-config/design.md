# Design — Multi-Provider Configuration

> Source of truth ported from `docs/superpowers/specs/2026-06-20-multi-provider-config-design.md` (Draft v2, amended 2026-07-25). That doc remains in the repo for history; this design supersedes it for implementation.

## Context

Iriguchi v1 (on `feat/v1-implementation`) is a Bun/Hono gateway exposing an OpenAI-compatible `/v1/chat/completions` surface and running Claude Agent SDK agents per request. It originally reached exactly one Anthropic-shaped backend via `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`, mutating `process.env` around each `query()` call. Task 1 of this change (commit `f6c59b1`) already replaced that with a provider registry in config and the SDK's per-query `env` option.

Reference deployment: `lmstudio` (`http://localhost:1234`, model `ornith-1.0-35b`, default), `anthropic` (`claude-opus-5`), `openrouter` (`https://openrouter.ai/api/v1/anthropic`, `moonshotai/kimi-k3`).

## Goals / Non-Goals

**Goals:**
- Named-provider registry: Anthropic direct, OpenRouter's Anthropic endpoint, LM Studio, and future Anthropic-compat backends configured side by side.
- Per-provider required default model; agents and vanilla requests always resolve to a model their routed provider serves.
- Agent manifests select a provider via optional `provider`; register/refresh-time validation.
- No credential leakage between concurrent requests to different providers.
- Client contract preserved: clients never see providers.

**Non-Goals:**
- OpenAI-shaped providers (different codepath/SDK; deferred).
- Automatic model-name translation across providers (raw pass-through).
- Provider fallback chains, per-provider rate limiting, cost tracking, model allowlists.
- Client-side provider selection (`iri_provider` in request body is explicitly disallowed).
- Backward compatibility with `ANTHROPIC_*` env vars or the global `IRI_DEFAULT_MODEL`.

## Decisions

1. **Provider scope — Anthropic-shaped endpoint, any model.** Originally "Claude-family only"; amended 2026-07-25. The real constraint is "behaves well behind an Anthropic-shaped, tool-using agent loop" — Kimi K3 and LM Studio-served local models qualify. Residual risk of Claude-tuned SDK prompting is handled by a per-provider e2e smoke test rather than a scope exclusion.
2. **Config shape — env-var triples.** `IRI_PROVIDER_<NAME>_API_KEY` / `_BASE_URL` / `_DEFAULT_MODEL`, name `[A-Z0-9]+` (no underscores/hyphens, so suffix boundaries are unambiguous), stored lowercased. All three required per provider; any partial set is a "half-configured provider" startup error. `IRI_DEFAULT_PROVIDER` required when more than one provider is configured. Alternative considered: JSON config file — rejected to stay consistent with the existing `IRI_*` env convention.
3. **Per-provider default models; global default removed.** `Provider.defaultModel` is required; `Config.defaultModel` and `IRI_DEFAULT_MODEL` are deleted. A stale `IRI_DEFAULT_MODEL` in the env fails startup loudly with a pointer to the per-provider var. Rationale: a global default can only name a model that exists on one provider — it is a guaranteed foot-gun the moment a second provider is configured.
4. **Selection axis — the agent owns provider choice.** Manifest `provider` field (optional, `z.string().min(1)`); vanilla requests use `config.defaultProvider`; no client override. Cross-validation against configured providers happens at register/refresh time, outside the Zod schema.
5. **Model resolution — `request.model || agent.default_model || provider.defaultModel`.** Provider resolution happens first and is independent of the model; `request.model` never influences routing. Accepted corners: (a) a vanilla client naming a model the default provider doesn't serve fails upstream, mitigated by `/v1/models` advertising only the default provider's default model (hardcoded Claude ids dropped); (b) an agent with `provider` but no `default_model` inherits the routed provider's default — always a model that provider serves.
6. **Credential isolation — SDK per-query `env` option** (implemented in Task 1). The options `env` replaces the subprocess environment, so `process.env` is spread in to preserve `PATH`/`HOME`. No `process.env` mutation, no mutex, streams fully concurrent. Fallback (serialized env-var swap) was designed but not needed.
7. **Registration vs refresh asymmetry.** Registration rejects atomically on any unknown provider reference (400 `invalid_request_error`, code `unknown_provider`). Background refresh warns (`event: "manifest.refresh_failed"`, `reason: "unknown_provider"`, matching the existing refresh-failure event) and keeps the cached manifest — matching the existing stale-on-error policy so removing a provider degrades loudly, not silently.
8. **Runner runtime guard.** If a stored agent references a provider missing from config at request time, throw `GatewayError` 500 `internal_error` code `unknown_provider`.

## Risks / Trade-offs

- [Non-Claude models behind the Claude-tuned SDK loop may follow tool-use prompting poorly] → gated e2e smoke per provider class (Anthropic direct, OpenRouter/Kimi, LM Studio/Ornith); first run of each smoke is the acceptance check. **Confirmed real (2026-07-25):** the LM Studio smoke fails before prompting quality is even in play — Ornith's chat template breaks LM Studio's tool-parser generation under the Agent SDK's harness request, and qwen3-coder-30b overflows its loaded context window on the harness prompt. Local models need a large configured context and a harness-compatible chat template; simple Anthropic-shaped requests work fine either way.
- [LM Studio's Anthropic `/v1/messages` surface unverified on this machine (server was down)] → verified implicitly by the LM Studio smoke; base URL `http://localhost:1234` already confirmed against the Hermes config using the same server.
- [Breaking env change strands stale `.env` files] → startup fails loudly for missing providers and for legacy `IRI_DEFAULT_MODEL`; single-PR atomic rollout, no dual-read window; `.env.example` rewritten.
- [Concurrency isolation is claimed but only provable under load] → dedicated integration test: two providers backed by two fake Anthropic servers, concurrent requests, assert each landed on its own baseUrl.
- [`/v1/models` shrinking to one entry may surprise clients that enumerated models] → accepted; the previous hardcoded Claude list was wrong for non-Anthropic defaults anyway.

## Migration Plan

Single PR on `feat/v1-implementation`, atomic swap: gateway code, tests, weather-app demo, and docs update together. Operators update `.env` in one step. Rollback = revert the PR; no data migration (SQLite schema untouched).

## Open Questions

- None blocking. Model-aware provider routing (inferring provider from `request.model`) is explicitly rejected for now; revisit only if vanilla-client model mismatches become a real support burden.
