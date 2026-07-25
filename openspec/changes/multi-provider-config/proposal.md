# Multi-Provider Configuration

> Converted from `docs/superpowers/specs/2026-06-20-multi-provider-config-design.md` (Draft v2, amended 2026-07-25) and its companion plan. Task 1 of the original plan (provider registry + credential isolation) is already implemented on `feat/v1-implementation` (commit `f6c59b1`).

## Why

Iriguchi currently talks to a single Anthropic-shaped backend wired through fixed `ANTHROPIC_*` env vars, so every agent is forced onto the same provider and model family. A named-provider registry lets the gateway route different agents to different Anthropic-shaped backends concurrently — local LM Studio (Ornith), Anthropic direct (Opus 5), and OpenRouter (Kimi K3) side by side.

## What Changes

- **BREAKING**: `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` are removed. Providers are configured as `IRI_PROVIDER_<NAME>_API_KEY` / `_BASE_URL` / `_DEFAULT_MODEL` triples plus `IRI_DEFAULT_PROVIDER`.
- **BREAKING**: the global `IRI_DEFAULT_MODEL` is removed; each provider carries a required default model. Its presence in the env becomes a startup error.
- Agent manifests gain an optional `provider` field selecting a configured provider; registration rejects manifests referencing unknown providers (400 `unknown_provider`); background refresh keeps the stale manifest and warns instead.
- Runtime model resolution becomes `request.model || agent.default_model || routed provider's defaultModel`.
- `/v1/models` advertises only the default provider's default model (drops hardcoded Claude ids).
- Credential isolation under concurrency via the Claude Agent SDK's per-query `env` option — no `process.env` mutation (already implemented).
- Scope: providers must speak Anthropic `/v1/messages`, but any model behind such an endpoint is supported (not Claude-only); each provider class gets a gated e2e smoke test.

## Capabilities

### New Capabilities

- `provider-routing`: configuring named Anthropic-shaped providers (registry, per-provider default models, default provider), selecting a provider per agent via the manifest, resolving model and credentials per request without cross-request leakage, and validating provider references at registration/refresh time.

### Modified Capabilities

<!-- No existing OpenSpec specs yet; the v1 gateway predates OpenSpec adoption. -->

## Impact

- **Code**: `src/config.ts`, `src/agent/runner.ts`, `src/routes/openai.ts`, `src/routes/registration.ts`, `src/registry/schema.ts`, `src/registry/refresher.ts`, `src/server.ts`, test suite (`tests/unit`, `tests/integration`, `tests/e2e`), `.env.example`, `README.md`.
- **Operators**: existing `.env` files must migrate to the `IRI_PROVIDER_*` pattern in one step (no dual-read window). Reference deployment: `lmstudio` → `ornith-1.0-35b` (default), `anthropic` → `claude-opus-5`, `openrouter` → `moonshotai/kimi-k3`.
- **Clients**: OpenAI-compatible contract unchanged; clients never see providers. `/v1/models` output shrinks to the default provider's default model.
- **Branch**: work continues on `feat/v1-implementation`.
