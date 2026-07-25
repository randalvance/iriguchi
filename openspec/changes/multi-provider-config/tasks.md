# Tasks — Multi-Provider Configuration

> Mirrors `docs/superpowers/plans/2026-06-20-multi-provider-config.md` (detailed steps and code live there). Group 1 was completed in commit `f6c59b1` on `feat/v1-implementation`. All groups: `bun test` green and `bun run typecheck` clean at the final commit.

## 1. Provider registry — config + runner + test fixtures

- [x] 1.1 Rewrite `src/config.ts`: `providers` registry parsed from `IRI_PROVIDER_<NAME>_*` env vars, `defaultProvider` resolution, half-configured/no-provider/unknown-default startup errors
- [x] 1.2 Update `src/agent/runner.ts`: replace `process.env` mutation with the SDK per-query `env` option (spread `process.env`, override `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL` per provider)
- [x] 1.3 Update `tests/setup.ts` and all unit/integration/e2e fixtures to the new env-var pattern

## 2. Agent manifest provider field

- [ ] 2.1 Add optional `provider: z.string().min(1)` to the agent schema in `src/registry/schema.ts` (test-first: parses with/without, rejects empty string)
- [ ] 2.2 Runner resolves `agent?.provider ?? config.defaultProvider`; test that agent provider wins over default and vanilla requests use the default

## 3. Register/refresh-time provider validation

- [ ] 3.1 `src/routes/registration.ts`: after `manifestSchema.parse`, reject atomically with 400 `unknown_provider` when any agent references an unconfigured provider
- [ ] 3.2 `src/registry/refresher.ts` (+ caller in `src/server.ts`): on refresh, log `refresh_rejected` / `unknown_provider` and retain the cached manifest

## 4. Concurrency isolation test

- [ ] 4.1 Integration test: two apps on two providers backed by two fake Anthropic servers; concurrent chat requests each land on their own baseUrl with their own key

## 5. Per-provider default models

- [ ] 5.1 `src/config.ts`: require `IRI_PROVIDER_<NAME>_DEFAULT_MODEL` (third suffix in the provider regex), drop `Config.defaultModel`, fail startup on legacy `IRI_DEFAULT_MODEL` (test-first, incl. fixtures)
- [ ] 5.2 `src/agent/runner.ts`: model chain `request.model || agent.default_model || provider.defaultModel` (test: agent with provider but no model gets the routed provider's default)
- [ ] 5.3 `src/routes/openai.ts`: `/v1/models` returns only the default provider's `defaultModel`; drop hardcoded Claude ids

## 6. Docs

- [ ] 6.1 Rewrite `.env.example` around provider triples (anthropic/openrouter/lmstudio examples, no `IRI_DEFAULT_MODEL`)
- [ ] 6.2 README "Providers" section: env pattern, any-model-behind-Anthropic-shape scope, manifest `provider` example (`moonshotai/kimi-k3`), pass-through naming, provider-default inheritance
- [ ] 6.3 Update `examples/weather-app/README.md` gateway startup env vars

## 7. Final verification

- [ ] 7.1 Full suite green, typecheck clean; grep confirms no live references to `ANTHROPIC_API_KEY|ANTHROPIC_BASE_URL|IRI_DEFAULT_MODEL|config.defaultModel` outside the config legacy-var guard and docs
- [ ] 7.2 Gated e2e smoke per provider class (Anthropic direct, OpenRouter/Kimi K3, LM Studio/Ornith) exercising one tool-calling turn
