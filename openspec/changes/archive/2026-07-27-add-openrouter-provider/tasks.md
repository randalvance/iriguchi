## 1. Per-provider auth style in config

- [x] 1.1 Widen `Provider` in `src/config.ts` with `authStyle: "api_key" | "auth_token"`.
- [x] 1.2 Extend `PROVIDER_KEY_RE` to also match `AUTH_STYLE`, and collect it alongside the existing triple in `loadProviders`.
- [x] 1.3 Default `authStyle` to `api_key` when the var is absent, so every existing provider resolves exactly as it does today. `AUTH_STYLE` alone must NOT be enough to define a provider — the three-var triple is still required, and a name seen only via `AUTH_STYLE` must raise the existing half-configured error.
- [x] 1.4 Reject any other value at startup with an error naming the provider and listing `api_key` / `auth_token`, matching the fail-fast style of the existing triple validation.
- [x] 1.5 Unit-test in `tests/unit/config.test.ts`: absent → `api_key`; `auth_token` parses; unknown value throws naming the provider; two providers resolve independent styles; `AUTH_STYLE` without the triple still throws half-configured.

## 2. Credential export in the runner

- [x] 2.1 In `src/agent/runner.ts`, replace the unconditional `ANTHROPIC_API_KEY: provider.apiKey` with a branch on `provider.authStyle`.
- [x] 2.2 For `auth_token`, set `ANTHROPIC_AUTH_TOKEN` to the provider key and `ANTHROPIC_API_KEY` to the empty string — present, not omitted. Add a comment stating that omitting it makes the SDK fall back to authenticating against Anthropic directly, so it is not dead code.
- [x] 2.3 Confirm `ANTHROPIC_BASE_URL` is still set from `provider.baseUrl` in both styles, and that `...process.env` cannot let an ambient `ANTHROPIC_API_KEY` survive into an `auth_token` run.
- [x] 2.4 Test the env the runner actually builds, for both styles. Assert on **key presence** for the empty-string case (`"ANTHROPIC_API_KEY" in env` plus `=== ""`), not merely falsiness — a falsy assertion passes for the omitted case too, which is the bug this guards.
- [x] 2.5 Extend the concurrency test in `tests/integration/multi-provider-concurrency.test.ts` so one provider uses each style, asserting neither run sees the other's credential.

## 3. Tool-loop verification

- [x] 3.1 Add `tests/integration/agent-tool-loop.test.ts` driving the full loop with `spinUpFakeAnthropic({ responses: [[tool_use], [text]] })` and a Hono stub app: agent declares an `api_call` tool, the scripted provider elects to call it, the stub receives the request, the result returns, and the final text derives from it.
- [x] 3.2 Assert the stub app received the model-generated arguments and `Authorization: Bearer <app_token>`.
- [x] 3.3 Assert the run's final assistant content contains text derived from the tool result, so a broken result hand-back cannot pass.
- [x] 3.4 Add a failing-tool case: the stub returns non-2xx, the model receives an error payload as the tool result, and the run still completes rather than aborting.
- [x] 3.5 Add an agent-with-no-tools case asserting no tool server is attached and no app request is made.
- [x] 3.6 Structure the assertions so a failure names the stage that broke (exposure / app request / result hand-back / final answer) rather than a bare content mismatch.
- [x] 3.7 Confirm the whole file runs in the default `bun test` with no provider credentials and no network.
- [x] 3.9 (added during apply) Fix `tests/helpers/fake-anthropic.ts`: add content-aware `respond` scripting and emit `stop_reason: "tool_use"` for tool turns. Index-based scripting misaligned with the SDK's preliminary tool-less call, which made the existing tool test in `runner.test.ts` pass without the app ever being invoked.

- [x] 3.8 (added during apply) Strengthen the existing tool test in `tests/integration/runner.test.ts` to assert the app endpoint was actually called.

## 4. OpenRouter configuration and docs

- [x] 4.1 Add the OpenRouter recipe to `.env.example`: the three-var triple with `IRI_PROVIDER_OPENROUTER_BASE_URL=https://openrouter.ai/api`, `IRI_PROVIDER_OPENROUTER_DEFAULT_MODEL=moonshotai/kimi-k3`, and `IRI_PROVIDER_OPENROUTER_AUTH_STYLE=auth_token`. Placeholder key only.
- [x] 4.2 Document in `README.md`: OpenRouter speaks the Anthropic Messages surface so no translation is needed; the auth-style var and why `ANTHROPIC_API_KEY` must be empty rather than unset; and that model names are OpenRouter slugs (`moonshotai/kimi-k3` — `moonshot/…` 404s).
- [x] 4.3 Note in `docs/app-integration.md` that an agent selects a provider via `provider` in its manifest, and that registration rejects unconfigured provider names — the mechanism for routing one agent to OpenRouter while others stay local.
- [x] 4.4 State plainly in the README that OpenRouter is billed per token, unlike the local default, and that per-agent `provider` selection is the cost boundary.

## 5. Verification

- [x] 5.1 Run `bun test` and `bunx tsc --noEmit`; confirm no regressions, and that every existing provider test passes without any `AUTH_STYLE` var present.
- [x] 5.2 Run `openspec validate add-openrouter-provider` and resolve findings.
- [x] 5.3 No new case needed: `tests/e2e/provider-smoke.test.ts` is already parametrized over every configured provider and asserts `toolCalls > 0`, so OpenRouter is covered by configuring it. Documented the exact invocation in that file instead of adding a redundant hardcoded case.
- [x] 5.4 **Requires the user's OpenRouter key and spends money.** Run the live smoke and confirm a tool-carrying request is accepted rather than rejected at parser/translation time, as LM Studio did.

- [x] 5.5 (added during apply) Fix the e2e harness: its in-test `Bun.serve` lacked `idleTimeout`, so Bun's 10s default closed the socket before a slow provider produced its first token. `src/server.ts` already sets it from `requestTimeoutMs`; only the tests were affected.

## 6. Wire up the categorizer (cross-repo, `~/dev/finance-app`)

- [x] 6.1 Add `provider: "openrouter"` to the `finance-categorizer` agent in `financeAppManifest` (`src/lib/iriguchi.ts`), leaving other agents unaffected.
- [x] 6.2 Decide whether to also set the agent's `default_model`, or inherit `moonshotai/kimi-k3` from the provider default — see the open question in `design.md`.
- [x] 6.3 Extend the manifest shape test to cover the `provider` field, so a typo fails in the app's own suite rather than as an `unknown_provider` rejection at registration.
- [x] 6.4 Gateway restarted to pick up the new .env; registration with `provider: "openrouter"` succeeds and the stored manifest routes the agent to openrouter. **Your dev server still needs a restart** so finance-app holds the current rotated app token.
- [x] 6.5 Import flow confirmed working end to end against OpenRouter + Kimi K3.
- [x] 6.6 (added during apply) Raise the categorizer client timeout. `callCategorizerAgent` used `AbortSignal.timeout(10_000)`, but a measured agentic run takes ~43s, so the client aborted every request while the gateway succeeded. Now 180s, under the gateway's 255s socket idle timeout; registration keeps its own 10s.
