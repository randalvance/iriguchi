## 1. Scripted Responses provider test helper

- [ ] 1.1 Add `tests/helpers/fake-responses-provider.ts`: a Bun server serving `POST /v1/responses`, scripted with successive responses like the existing `spinUpFakeAnthropic` (`responses: [[function_call], [text]]`).
- [ ] 1.2 Support emitting `function_call` output items with ids and JSON arguments, plain `message`/`output_text` items, and a mix of both in one response.
- [ ] 1.3 Support streaming mode, emitting `response.created`, `response.output_text.delta`, and `response.completed` events.
- [ ] 1.4 Support scripted failure modes: non-2xx with an error body, and connection refusal, so error classification can be tested.
- [ ] 1.5 Record every received request (headers and body) so tests can assert on `Authorization`, declared tools, and accumulated input items.

## 2. The agent loop

- [ ] 2.1 Add `src/agent/responses-loop.ts` exposing a run function over Responses input items, returning the run's output items plus terminal state.
- [ ] 2.2 Build the provider request: resolved model, agent `system_prompt` as `instructions` (generic instructions when no agent), caller input items, and `api_call` tools translated to `function` tool declarations from the manifest's `name`, `description`, and `parameters`.
- [ ] 2.3 Send the provider credential as an `Authorization: Bearer` header. Do not write any provider credential into the process environment or a subprocess.
- [ ] 2.4 Execute returned `function_call` items via the existing `invokeApiCallTool`, appending `function_call_output` items keyed by call id, and loop until a response returns none.
- [ ] 2.5 Handle several `function_call` items in one response — invoke each, one output item per call.
- [ ] 2.6 Refuse a `function_call` naming a tool the agent does not declare: produce an error result, make no outbound app request.
- [ ] 2.7 On app tool failure (non-2xx, timeout, unreachable), put an error payload in the `function_call_output` and continue the run.
- [ ] 2.8 Enforce `IRI_MAX_AGENT_TURNS` provider round trips in the loop itself, and report a turn-limited terminal state distinct from normal completion.
- [ ] 2.9 Tolerate unknown output item types without failing the run.
- [ ] 2.10 Classify provider failures: preserve status and message for a rejection; report transport failures (refused, timeout) distinctly.
- [ ] 2.11 Integration-test all of the above against the scripted provider, including the tool-loop, multi-call turns, undeclared tools, tool failure, turn bounding, and both failure classifications.

## 3. Chat completions on the new loop

- [ ] 3.1 Translate `messages` into Responses input items on the way in.
- [ ] 3.2 Translate run output back into `chat.completion` and `chat.completion.chunk` shapes, reusing the existing aggregation for the non-streaming body.
- [ ] 3.3 Preserve every behavior in the existing `chat-completions-protocol` spec: `stream` negotiation, absent-`stream` default, non-boolean `stream` → 400, `X-Request-Id`, JSON errors in both modes.
- [ ] 3.4 Map the turn-limited terminal state to `finish_reason: "length"`, as today.
- [ ] 3.5 Keep `iri_show_tool_calls=true` working, translating the loop's function calls into `tool_calls`.
- [ ] 3.6 Run the existing chat/runner integration tests, ported to the scripted provider, and confirm the surface is unchanged. **This step is the regression gate — do not proceed until it is green.**

## 4. The Responses surface

- [ ] 4.1 Add `src/routes/responses.ts` mounting `POST /v1/responses` behind the same client bearer auth.
- [ ] 4.2 Validate the request: `input` as string or item array (reject absent/malformed with 400 before any provider call), `stream` boolean-or-absent, `iri_agent`, `instructions`, `tools`, `max_output_tokens`.
- [ ] 4.3 Reject `store: true` and non-null `previous_response_id` with `400` and a message stating the gateway is stateless; accept `store: false` and absent.
- [ ] 4.4 Build the non-streaming `response` object: `object: "response"`, `id`, `created_at`, `model`, `status`, and an `output` array with the assistant `message` / `output_text` item; empty text yields an empty string, not null.
- [ ] 4.5 Report `status: "incomplete"` with the reason when a run is turn-limited, rather than `"completed"`.
- [ ] 4.6 Implement streaming: `response.created`, `response.output_text.delta`, `response.completed`, with no `chat.completion.chunk` objects and no `[DONE]` sentinel.
- [ ] 4.7 Match the existing surface on agent selection and errors: unknown `iri_agent` → `404` `unknown_agent`; pre-commit errors are JSON in both modes.
- [ ] 4.8 Integration-test the surface, including a **cross-surface equivalence test**: the same agent and input through `/v1/responses` and `/v1/chat/completions` produce the same assistant text.

## 5. Remove the Agent SDK

- [ ] 5.1 Resolve the skills decision from `design.md` D4 — inline skill content into `instructions`, or remove `skills` from `ManifestSchema`. **Do not start this group until that is decided**; it is a manifest contract change.
- [ ] 5.2 Delete the SDK-based path in `src/agent/runner.ts` and the SDK event adaptation it depends on.
- [ ] 5.3 Remove `materializeSkills` / `src/agent/skills.ts` and its tests, or repoint them per 5.1.
- [ ] 5.4 Remove `@anthropic-ai/claude-agent-sdk` from `package.json`; confirm nothing still imports it.
- [ ] 5.5 Delete `tests/helpers/fake-anthropic.ts` once no test references it.
- [ ] 5.6 Update `ManifestSchema` and its tests per 5.1, and note the change in `docs/app-integration.md`.

## 6. Provider configuration

- [ ] 6.1 Reframe provider config as Responses-shaped: `BASE_URL` addresses a Responses endpoint; update `src/config.ts` types and comments accordingly.
- [ ] 6.2 Drop the `IRI_PROVIDER_<NAME>_AUTH_STYLE` mechanism introduced by `add-openrouter-provider` — credentials are now request headers, so the distinction no longer exists.
- [ ] 6.3 Assert that an ambient `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` in the gateway environment has no effect on authentication or routing.
- [ ] 6.4 Port the multi-provider concurrency test to assert per-request header isolation rather than per-subprocess env isolation.
- [ ] 6.5 Update `.env.example`, `README.md`, and `docs/app-integration.md`: providers must serve the Responses API; document `https://openrouter.ai/api/v1/responses` and the `moonshotai/kimi-k3` slug.

## 7. Verification

- [ ] 7.1 Run `bun test` and `bunx tsc --noEmit`; confirm no regressions.
- [ ] 7.2 Run `openspec validate adopt-openai-responses-api` and resolve findings.
- [ ] 7.3 Confirm the full suite still runs with no provider credentials and no network.
- [ ] 7.4 Add an opt-in live run against a real Responses provider in `tests/e2e/`, gated like the existing e2e tests.
- [ ] 7.5 **Requires the user's key and spends money.** Execute the live run and confirm a tool-carrying request completes the loop end to end. Per `design.md`, do not perform group 5 (SDK removal) until this passes.

## 8. Client migration (cross-repo, `~/dev/finance-app`)

- [ ] 8.1 Decide whether `callCategorizerAgent` stays on `/v1/chat/completions` (supported indefinitely) or moves to `/v1/responses`.
- [ ] 8.2 If moving: post `input` items plus `instructions`, and read assistant text from the `output` array rather than `choices[0].message.content`.
- [ ] 8.3 Update the finance-app tests that assert the outgoing request body shape (`iri_agent`, `stream: false`) to match whichever surface is used.
