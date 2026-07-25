# Multi-Provider Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-provider Anthropic wiring with a named-provider registry so the gateway can route different agents to Anthropic direct, OpenRouter's Anthropic endpoint, and future Anthropic-compat backends concurrently.

**Architecture:** Server config exposes `providers: Record<string, {name, baseUrl, apiKey, defaultModel}>` and a `defaultProvider` name. Agent manifests gain an optional `provider` field. The runner resolves `agent?.provider ?? config.defaultProvider` and passes that provider's `apiKey` / `baseUrl` to the Claude Agent SDK via the SDK's per-query `env` option (no `process.env` mutation, no cross-request leakage). Registration rejects manifests that reference unknown providers. *(Amended 2026-07-25, design v2:)* each provider carries a required `defaultModel`; the global `IRI_DEFAULT_MODEL` is removed and the model chain becomes `request.model || agent.default_model || provider.defaultModel` (Task 5).

**Tech Stack:** Bun, Hono, Zod v4, `@anthropic-ai/claude-agent-sdk`, `bun:sqlite`.

## Global Constraints

- Providers must speak the Anthropic `/v1/messages` shape. Non-Anthropic-shaped providers are out of scope.
- No backward compatibility with `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`. Remove those env vars entirely.
- No client-side provider override (`iri_provider` in request body is explicitly disallowed).
- Env-var pattern: `IRI_PROVIDER_<UPPERCASE_ALPHANUMERIC_NAME>_API_KEY`, `..._BASE_URL`, and (Task 5) `..._DEFAULT_MODEL`. Provider names are `[A-Z0-9]+` in env keys, stored lowercased in the registry.
- (Task 5) All three provider vars are required per provider; `IRI_DEFAULT_MODEL` is removed and its presence in the env is a startup error. Models are not Claude-only: any model behind an Anthropic-shaped endpoint is in scope (design decision 1, as amended).
- Agent manifest `provider` field: optional; when set, `z.string().min(1)`.
- Startup fails fast if: no providers configured; a half-configured provider (only one of API_KEY / BASE_URL); `IRI_DEFAULT_PROVIDER` names an unknown provider; or `IRI_DEFAULT_PROVIDER` is unset with more than one provider configured.
- Full test suite (`bun test`) must be green at the end of every task's final commit. Typecheck (`bun run typecheck`) must be clean at the end of every task.
- Design spec: `docs/superpowers/specs/2026-06-20-multi-provider-config-design.md`.

---

## Task 1: Provider registry — Config + runner + all test fixtures

**Files:**
- Modify: `src/config.ts`
- Modify: `src/agent/runner.ts`
- Modify: `tests/setup.ts`
- Modify: `tests/unit/config.test.ts`
- Modify: `tests/integration/models.test.ts`
- Modify: `tests/integration/registration.test.ts`
- Modify: `tests/integration/chat.test.ts`
- Modify: `tests/integration/server-smoke.test.ts`
- Modify: `tests/integration/runner.test.ts`
- Modify: `tests/integration/health.test.ts`
- Modify: `tests/e2e/full-flow.test.ts`

**Interfaces:**
- Consumes: `@anthropic-ai/claude-agent-sdk` `query({prompt, options})` where `options.env?: Record<string, string | undefined>`. When `env` is set, it REPLACES the subprocess environment — the runner must spread `process.env` into it to preserve `PATH`, `HOME`, etc.
- Produces:
  - `type Provider = { name: string; baseUrl: string; apiKey: string }`
  - `Config.providers: Record<string, Provider>` (keyed by lowercased name).
  - `Config.defaultProvider: string` (guaranteed to be a key in `providers`).
  - `Config` no longer has `anthropicApiKey` or `anthropicBaseUrl`.
  - Runner still exposes the same `runAgentStream(opts)` signature; internally it selects `config.providers[config.defaultProvider]` (agent.provider added in Task 2).

- [ ] **Step 1: Write the failing config unit tests**

Replace the entire body of `tests/unit/config.test.ts` with:

```ts
import { describe, it, expect } from "bun:test";
import { loadConfig } from "../../src/config.ts";

const baseEnv = () => ({
  IRI_API_KEY: "client-key",
  IRI_REGISTRATION_SECRET: "reg-secret",
  IRI_PROVIDER_ANTHROPIC_API_KEY: "ak-anthropic",
  IRI_PROVIDER_ANTHROPIC_BASE_URL: "https://api.anthropic.com",
});

describe("loadConfig", () => {
  it("returns defaults for optional vars with a single provider", () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.port).toBe(4000);
    expect(cfg.defaultModel).toBe("claude-sonnet-4-6");
    expect(cfg.maxAgentTurns).toBe(20);
    expect(cfg.toolCallTimeoutMs).toBe(30000);
    expect(cfg.manifestCacheTtlMs).toBe(300000);
    expect(cfg.requestTimeoutMs).toBe(300000);
    expect(cfg.dbPath).toBe("./iriguchi.db");
    expect(cfg.tmpDir).toBe("./.iri-tmp");
    expect(cfg.apiKey).toBe("client-key");
    expect(cfg.registrationSecret).toBe("reg-secret");
    expect(cfg.providers).toEqual({
      anthropic: { name: "anthropic", apiKey: "ak-anthropic", baseUrl: "https://api.anthropic.com" },
    });
    expect(cfg.defaultProvider).toBe("anthropic");
  });

  it("parses multiple providers and honors explicit IRI_DEFAULT_PROVIDER", () => {
    const cfg = loadConfig({
      ...baseEnv(),
      IRI_PROVIDER_OPENROUTER_API_KEY: "sk-or",
      IRI_PROVIDER_OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1/anthropic",
      IRI_DEFAULT_PROVIDER: "openrouter",
    });
    expect(Object.keys(cfg.providers).sort()).toEqual(["anthropic", "openrouter"]);
    expect(cfg.providers.openrouter).toEqual({
      name: "openrouter",
      apiKey: "sk-or",
      baseUrl: "https://openrouter.ai/api/v1/anthropic",
    });
    expect(cfg.defaultProvider).toBe("openrouter");
  });

  it("lowercases provider names from env-var keys", () => {
    const cfg = loadConfig({
      IRI_API_KEY: "k",
      IRI_REGISTRATION_SECRET: "s",
      IRI_PROVIDER_OPENROUTER_API_KEY: "sk-or",
      IRI_PROVIDER_OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1/anthropic",
    });
    expect(cfg.providers.openrouter).toBeDefined();
    expect(cfg.defaultProvider).toBe("openrouter");
  });

  it("throws when no providers are configured", () => {
    expect(() =>
      loadConfig({ IRI_API_KEY: "k", IRI_REGISTRATION_SECRET: "s" }),
    ).toThrow(/no providers configured/i);
  });

  it("throws when a provider has API_KEY without BASE_URL", () => {
    expect(() =>
      loadConfig({
        IRI_API_KEY: "k",
        IRI_REGISTRATION_SECRET: "s",
        IRI_PROVIDER_ANTHROPIC_API_KEY: "ak",
      }),
    ).toThrow(/half-configured provider "anthropic".*BASE_URL/i);
  });

  it("throws when a provider has BASE_URL without API_KEY", () => {
    expect(() =>
      loadConfig({
        IRI_API_KEY: "k",
        IRI_REGISTRATION_SECRET: "s",
        IRI_PROVIDER_ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      }),
    ).toThrow(/half-configured provider "anthropic".*API_KEY/i);
  });

  it("throws when IRI_DEFAULT_PROVIDER names an unknown provider", () => {
    expect(() =>
      loadConfig({ ...baseEnv(), IRI_DEFAULT_PROVIDER: "openrouter" }),
    ).toThrow(/IRI_DEFAULT_PROVIDER.*"openrouter".*not configured/i);
  });

  it("throws when multiple providers are configured with no IRI_DEFAULT_PROVIDER", () => {
    expect(() =>
      loadConfig({
        ...baseEnv(),
        IRI_PROVIDER_OPENROUTER_API_KEY: "sk-or",
        IRI_PROVIDER_OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1/anthropic",
      }),
    ).toThrow(/multiple providers.*IRI_DEFAULT_PROVIDER unset.*candidates/i);
  });

  it.each(["IRI_API_KEY", "IRI_REGISTRATION_SECRET"])(
    "throws if required var %s is missing",
    (name) => {
      const env: Record<string, string> = { ...baseEnv() };
      delete env[name];
      expect(() => loadConfig(env)).toThrow(name);
    },
  );

  it("honors overrides for optional numeric vars", () => {
    const cfg = loadConfig({
      ...baseEnv(),
      IRI_PORT: "5050",
      IRI_MAX_AGENT_TURNS: "5",
      IRI_TOOL_CALL_TIMEOUT_MS: "1000",
      IRI_MANIFEST_CACHE_TTL_MS: "60000",
      IRI_REQUEST_TIMEOUT_MS: "120000",
    });
    expect(cfg.port).toBe(5050);
    expect(cfg.maxAgentTurns).toBe(5);
    expect(cfg.toolCallTimeoutMs).toBe(1000);
    expect(cfg.manifestCacheTtlMs).toBe(60000);
    expect(cfg.requestTimeoutMs).toBe(120000);
  });

  it("throws on non-numeric numeric vars", () => {
    expect(() => loadConfig({ ...baseEnv(), IRI_PORT: "not-a-number" })).toThrow(
      /IRI_PORT/,
    );
  });
});
```

- [ ] **Step 2: Run the config tests to see them fail**

Run: `bun test tests/unit/config.test.ts`
Expected: FAILS. Multiple failures citing `anthropicApiKey`/`anthropicBaseUrl` still present, or `providers` undefined.

- [ ] **Step 3: Rewrite `src/config.ts`**

Replace the entire file contents with:

```ts
export type Provider = {
  name: string;
  baseUrl: string;
  apiKey: string;
};

export type Config = {
  port: number;
  defaultModel: string;
  maxAgentTurns: number;
  toolCallTimeoutMs: number;
  manifestCacheTtlMs: number;
  requestTimeoutMs: number;
  dbPath: string;
  tmpDir: string;
  providers: Record<string, Provider>;
  defaultProvider: string;
  apiKey: string;
  registrationSecret: string;
};

const REQUIRED = ["IRI_API_KEY", "IRI_REGISTRATION_SECRET"] as const;

const PROVIDER_KEY_RE = /^IRI_PROVIDER_([A-Z0-9]+)_(API_KEY|BASE_URL)$/;

function intVar(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`Invalid integer for ${key}: ${raw}`);
  }
  return n;
}

function loadProviders(env: Record<string, string | undefined>): Record<string, Provider> {
  const seen: Record<string, { apiKey?: string; baseUrl?: string }> = {};
  for (const [key, val] of Object.entries(env)) {
    if (val === undefined || val === "") continue;
    const m = key.match(PROVIDER_KEY_RE);
    if (!m) continue;
    const name = m[1].toLowerCase();
    const field = m[2];
    seen[name] ??= {};
    if (field === "API_KEY") seen[name].apiKey = val;
    else seen[name].baseUrl = val;
  }
  const providers: Record<string, Provider> = {};
  for (const [name, parts] of Object.entries(seen)) {
    if (!parts.apiKey) {
      throw new Error(
        `half-configured provider "${name}": missing IRI_PROVIDER_${name.toUpperCase()}_API_KEY`,
      );
    }
    if (!parts.baseUrl) {
      throw new Error(
        `half-configured provider "${name}": missing IRI_PROVIDER_${name.toUpperCase()}_BASE_URL`,
      );
    }
    providers[name] = { name, apiKey: parts.apiKey, baseUrl: parts.baseUrl };
  }
  if (Object.keys(providers).length === 0) {
    throw new Error(
      "no providers configured; set IRI_PROVIDER_<NAME>_API_KEY and IRI_PROVIDER_<NAME>_BASE_URL",
    );
  }
  return providers;
}

function resolveDefaultProvider(
  env: Record<string, string | undefined>,
  providers: Record<string, Provider>,
): string {
  const explicit = env.IRI_DEFAULT_PROVIDER;
  if (explicit) {
    if (!providers[explicit]) {
      throw new Error(
        `IRI_DEFAULT_PROVIDER names "${explicit}" but that provider is not configured; candidates: [${Object.keys(providers).join(", ")}]`,
      );
    }
    return explicit;
  }
  const names = Object.keys(providers);
  if (names.length === 1) return names[0];
  throw new Error(
    `multiple providers configured but IRI_DEFAULT_PROVIDER unset; candidates: [${names.join(", ")}]`,
  );
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  for (const name of REQUIRED) {
    if (!env[name]) throw new Error(`Missing required env var: ${name}`);
  }
  const providers = loadProviders(env);
  const defaultProvider = resolveDefaultProvider(env, providers);
  return {
    port: intVar(env, "IRI_PORT", 4000),
    defaultModel: env.IRI_DEFAULT_MODEL || "claude-sonnet-4-6",
    maxAgentTurns: intVar(env, "IRI_MAX_AGENT_TURNS", 20),
    toolCallTimeoutMs: intVar(env, "IRI_TOOL_CALL_TIMEOUT_MS", 30000),
    manifestCacheTtlMs: intVar(env, "IRI_MANIFEST_CACHE_TTL_MS", 300000),
    requestTimeoutMs: intVar(env, "IRI_REQUEST_TIMEOUT_MS", 300000),
    dbPath: env.IRI_DB_PATH || "./iriguchi.db",
    tmpDir: env.IRI_TMP_DIR || "./.iri-tmp",
    providers,
    defaultProvider,
    apiKey: env.IRI_API_KEY!,
    registrationSecret: env.IRI_REGISTRATION_SECRET!,
  };
}
```

- [ ] **Step 4: Run the config tests to see them pass**

Run: `bun test tests/unit/config.test.ts`
Expected: 11 pass.

- [ ] **Step 5: Update `tests/setup.ts` to the new env-var pattern**

Replace the entire file with:

```ts
// Ensure deterministic env for tests
process.env.IRI_API_KEY ||= "test-api-key";
process.env.IRI_REGISTRATION_SECRET ||= "test-registration-secret";
process.env.IRI_PROVIDER_ANTHROPIC_API_KEY ||= "test-anthropic-key";
process.env.IRI_PROVIDER_ANTHROPIC_BASE_URL ||= "https://api.anthropic.com";
process.env.IRI_DEFAULT_PROVIDER ||= "anthropic";
process.env.IRI_DEFAULT_MODEL ||= "claude-sonnet-4-6";
process.env.IRI_DB_PATH ||= ":memory:";
process.env.IRI_TMP_DIR ||= "/tmp/iri-test";
```

- [ ] **Step 6: Update `src/agent/runner.ts` — replace env-var swap with SDK `env` option**

The relevant window today is lines 39-45 (the `RunnerOpts` type) and lines 117-158 (the SDK invocation with `process.env` mutation). Change them as follows.

Replace lines 39-45:
```ts
export type RunnerOpts = {
  config: Pick<
    Config,
    "defaultModel" | "tmpDir" | "maxAgentTurns" | "toolCallTimeoutMs" | "anthropicApiKey" | "anthropicBaseUrl"
  >;
  store: Store;
  request: ChatRequest;
};
```
with:
```ts
export type RunnerOpts = {
  config: Pick<
    Config,
    "defaultModel" | "tmpDir" | "maxAgentTurns" | "toolCallTimeoutMs" | "providers" | "defaultProvider"
  >;
  store: Store;
  request: ChatRequest;
};
```

Replace the whole block from `const mcpServer =` (currently line 117) through the end of the `try { ... } finally { ... }` (currently line 158) with:

```ts
  const mcpServer =
    mcpTools.length > 0
      ? createSdkMcpServer({ name: "iriguchi-app-tools", version: "1.0.0", tools: mcpTools })
      : undefined;

  const providerName = config.defaultProvider;
  const provider = config.providers[providerName];
  if (!provider) {
    throw new GatewayError(
      500,
      "internal_error",
      `provider "${providerName}" resolved but not present in config.providers`,
      "unknown_provider",
    );
  }

  for (const c of translateSdkEvent({ type: "stream_start" }, tCtx)) {
    yield formatSseChunk(c);
  }

  const prompt = buildPrompt(request.messages);
  const sdkOptions: Record<string, unknown> = {
    model,
    systemPrompt,
    cwd,
    maxTurns: config.maxAgentTurns,
    settingSources: ["project"] as const,
    skills: "all" as const,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: provider.apiKey,
      ANTHROPIC_BASE_URL: provider.baseUrl,
    },
  };
  if (mcpServer) sdkOptions.mcpServers = { app: mcpServer };

  const sdkStream = query({ prompt, options: sdkOptions as any });
  for await (const evt of adaptSdkStream(sdkStream)) {
    for (const c of translateSdkEvent(evt, tCtx)) {
      yield formatSseChunk(c);
    }
  }
  for (const c of translateSdkEvent({ type: "done", reason: "stop" }, tCtx)) {
    yield formatSseChunk(c);
  }
  yield DONE_SENTINEL;
```

Note the deletion of the `try { ... } finally { ... }` wrapper and the four `process.env.ANTHROPIC_*` mutations. The SDK's per-call `env` option isolates credentials.

- [ ] **Step 7: Update `tests/integration/runner.test.ts`**

Replace the `baseConfig` helper (lines 22-28) with:

```ts
const baseConfig = () => ({
  defaultModel: "claude-sonnet-4-6",
  tmpDir: tmp,
  maxAgentTurns: 5,
  toolCallTimeoutMs: 1000,
  providers: {
    anthropic: {
      name: "anthropic",
      apiKey: "ak-test",
      baseUrl: "https://api.anthropic.com",
    },
  } as Record<string, { name: string; apiKey: string; baseUrl: string }>,
  defaultProvider: "anthropic",
});
```

Then update every call site that spreads `anthropicBaseUrl` into config. Each of the three occurrences at lines 41, 99, 116 currently reads:

```ts
config: { ...baseConfig(), anthropicBaseUrl: `http://localhost:${fake.port}` },
```

Replace each with:

```ts
config: {
  ...baseConfig(),
  providers: {
    anthropic: { name: "anthropic", apiKey: "ak-test", baseUrl: `http://localhost:${fake.port}` },
  },
},
```

- [ ] **Step 8: Update `tests/integration/chat.test.ts`**

Replace the `baseCfg` helper (lines 21-34) with:

```ts
const baseCfg = () => ({
  port: 0,
  defaultModel: "claude-sonnet-4-6",
  maxAgentTurns: 5,
  toolCallTimeoutMs: 1000,
  manifestCacheTtlMs: 1000,
  requestTimeoutMs: 5000,
  dbPath: ":memory:",
  tmpDir: tmp,
  providers: {
    anthropic: { name: "anthropic", apiKey: "ak", baseUrl: "https://api.anthropic.com" },
  } as Record<string, { name: string; apiKey: string; baseUrl: string }>,
  defaultProvider: "anthropic",
  apiKey: "client-key",
  registrationSecret: "reg",
});
```

Then at every occurrence of `const cfg = { ...baseCfg(), anthropicBaseUrl: \`http://localhost:${fake.port}\` };` (lines 64, 90, 115), replace with:

```ts
const cfg = {
  ...baseCfg(),
  providers: {
    anthropic: { name: "anthropic", apiKey: "ak", baseUrl: `http://localhost:${fake.port}` },
  },
};
```

- [ ] **Step 9: Update the remaining test files that reference `anthropicApiKey`/`anthropicBaseUrl`**

For each of these four files, replace the `anthropicApiKey: "ak"` / `anthropicBaseUrl: undefined` (or similar) pair inside the config literal with `providers: { anthropic: { name: "anthropic", apiKey: "ak", baseUrl: "https://api.anthropic.com" } }, defaultProvider: "anthropic"`:

- `tests/integration/models.test.ts` (lines 13-14)
- `tests/integration/registration.test.ts` (lines 44-45)
- `tests/integration/server-smoke.test.ts` (lines 13-14)
- `tests/integration/health.test.ts` (lines 16-17)

Concrete example for `tests/integration/health.test.ts` — replace the two lines:
```ts
        anthropicApiKey: "ak",
        anthropicBaseUrl: undefined,
```
with:
```ts
        providers: {
          anthropic: { name: "anthropic", apiKey: "ak", baseUrl: "https://api.anthropic.com" },
        },
        defaultProvider: "anthropic",
```

Apply the analogous edit to the other three files.

- [ ] **Step 10: Update `tests/e2e/full-flow.test.ts` — replace guard on `ANTHROPIC_API_KEY`**

Replace lines 12-14:
```ts
    if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY === "test-anthropic-key") {
      throw new Error("real ANTHROPIC_API_KEY required for e2e");
    }
```
with:
```ts
    if (
      !process.env.IRI_PROVIDER_ANTHROPIC_API_KEY ||
      process.env.IRI_PROVIDER_ANTHROPIC_API_KEY === "test-anthropic-key"
    ) {
      throw new Error("real IRI_PROVIDER_ANTHROPIC_API_KEY required for e2e");
    }
```

- [ ] **Step 11: Run the full test suite and typecheck**

Run: `bun test`
Expected: 102 pass / 1 skip / 0 fail (the same shape as pre-change; count may differ by ±5 due to the added config tests).

Run: `bun run typecheck`
Expected: exit code 0, no output.

- [ ] **Step 12: Commit**

```bash
git add src/config.ts src/agent/runner.ts tests/setup.ts tests/unit/config.test.ts tests/integration/runner.test.ts tests/integration/chat.test.ts tests/integration/models.test.ts tests/integration/registration.test.ts tests/integration/server-smoke.test.ts tests/integration/health.test.ts tests/e2e/full-flow.test.ts
git commit -m "$(cat <<'EOF'
feat(config): introduce named provider registry, remove ANTHROPIC_* env vars

Config now exposes providers: Record<string, {name, baseUrl, apiKey}> and a
defaultProvider name. Runner passes the resolved provider's credentials to
the SDK via query({options: {env}}), isolating per-request. All test
fixtures updated to the new shape.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Agent manifest — optional `provider` field + runner resolution

**Files:**
- Modify: `src/registry/schema.ts`
- Modify: `src/agent/runner.ts`
- Modify: `tests/unit/schema.test.ts`
- Modify: `tests/integration/runner.test.ts`

**Interfaces:**
- Consumes: `Config` from Task 1 (`providers`, `defaultProvider`).
- Produces:
  - `Agent.provider?: string` — validated as non-empty string when present.
  - Runner resolution: `providerName = agent?.provider ?? config.defaultProvider`; unknown provider at runtime throws `GatewayError(500, "internal_error", ..., "unknown_provider")`.

- [ ] **Step 1: Write the failing schema test**

Append these three tests to `tests/unit/schema.test.ts` inside the existing `describe("ManifestSchema", ...)` block:

```ts
  it("accepts an agent with an optional provider field", () => {
    const m = structuredClone(VALID_MANIFEST);
    (m.agents[0] as any).provider = "openrouter";
    const parsed = ManifestSchema.parse(m);
    expect(parsed.agents[0].provider).toBe("openrouter");
  });

  it("accepts an agent without a provider field (backward-shape-compatible for manifests)", () => {
    const m = structuredClone(VALID_MANIFEST);
    delete (m.agents[0] as any).provider;
    const parsed = ManifestSchema.parse(m);
    expect(parsed.agents[0].provider).toBeUndefined();
  });

  it("rejects an agent with empty-string provider", () => {
    const m = structuredClone(VALID_MANIFEST);
    (m.agents[0] as any).provider = "";
    expect(() => ManifestSchema.parse(m)).toThrow();
  });
```

- [ ] **Step 2: Run the schema tests to see them fail**

Run: `bun test tests/unit/schema.test.ts`
Expected: FAIL — the empty-string test may pass by accident (undefined field), but the provider-present test fails because `provider` is not a known field yet.

- [ ] **Step 3: Add `provider` to the agent schema**

In `src/registry/schema.ts`, modify the `AgentSchema` (currently lines 52-63) by adding one field between `default_model` and `tools`:

```ts
const AgentSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "agent id must be kebab-case"),
  name: z.string().min(1),
  description: z.string().min(1),
  system_prompt: z.string().min(1),
  default_model: z.string().optional(),
  provider: z.string().min(1).optional(),
  tools: z.array(ToolSchema).default([]),
  skills: z.array(SkillSchema).default([]),
});
```

- [ ] **Step 4: Run the schema tests to see them pass**

Run: `bun test tests/unit/schema.test.ts`
Expected: all schema tests pass, including the three new ones.

- [ ] **Step 5: Write a failing runner test for agent.provider resolution**

Append this test to `tests/integration/runner.test.ts` inside the `describe("runAgentStream — app-owned agent with tool call", ...)` block (or a new `describe` block at the file end — either works):

```ts
  it("routes to agent.provider's baseUrl when set, ignoring defaultProvider", async () => {
    const fakeDefault = spinUpFakeAnthropic({ turns: [{ kind: "text", text: "WRONG_PROVIDER" }] });
    const fakeAlt = spinUpFakeAnthropic({ turns: [{ kind: "text", text: "OK_ALT" }] });
    try {
      store.upsertApp({
        id: "alt-app",
        base_url: "http://unused",
        app_token: "app-tok",
        manifest: {
          manifest_version: "1",
          app: { id: "alt-app", name: "a", description: "a" },
          agents: [
            {
              id: "alt-bot",
              name: "Alt",
              description: "d",
              system_prompt: "you are alt",
              provider: "alt",
              tools: [],
              skills: [],
            } as any,
          ],
        },
      });
      const stream = runAgentStream({
        config: {
          ...baseConfig(),
          providers: {
            anthropic: { name: "anthropic", apiKey: "ak", baseUrl: `http://localhost:${fakeDefault.port}` },
            alt: { name: "alt", apiKey: "ak-alt", baseUrl: `http://localhost:${fakeAlt.port}` },
          },
          defaultProvider: "anthropic",
        },
        store,
        request: { requestId: "01H", agentId: "alt-bot", model: null, messages: [{ role: "user", content: "hi" }], showToolCalls: false },
      });
      const out = await collect(stream);
      expect(out).toContain("OK_ALT");
      expect(out).not.toContain("WRONG_PROVIDER");
    } finally {
      fakeDefault.stop();
      fakeAlt.stop();
    }
  });
```

- [ ] **Step 6: Run the runner test to see it fail**

Run: `bun test tests/integration/runner.test.ts`
Expected: the new test FAILS — the runner currently ignores `agent.provider` and routes to `config.defaultProvider`, which points at `fakeDefault`, so the output contains "WRONG_PROVIDER".

- [ ] **Step 7: Update the runner to prefer `agent.provider`**

In `src/agent/runner.ts`, in the `generate` async function, find the current line:
```ts
  const providerName = config.defaultProvider;
```
and change it to:
```ts
  const providerName = agent?.provider ?? config.defaultProvider;
```

- [ ] **Step 8: Run the runner tests to see them pass**

Run: `bun test tests/integration/runner.test.ts`
Expected: all runner tests pass, including the new one.

- [ ] **Step 9: Run the full test suite and typecheck**

Run: `bun test`
Expected: 105ish pass / 1 skip / 0 fail.

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add src/registry/schema.ts src/agent/runner.ts tests/unit/schema.test.ts tests/integration/runner.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): add optional provider field to agent manifest

Agent.provider names one of the gateway-configured providers. When set, the
runner routes that agent's requests to that provider's baseUrl/apiKey via
the SDK's env option; otherwise falls back to config.defaultProvider.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Register-time + refresh-time provider validation

**Files:**
- Modify: `src/routes/registration.ts`
- Modify: `src/registry/refresher.ts`
- Modify: `tests/integration/registration.test.ts`
- Modify: `tests/integration/refresher.test.ts`

**Interfaces:**
- Consumes: `Config.providers` from Task 1; `Agent.provider` from Task 2.
- Produces:
  - `POST /apps/register` and `POST /apps/:id/refresh-manifest` reject manifests whose agents reference an unconfigured provider with `400 invalid_request_error, code=unknown_provider`.
  - Background refresher on the same failure logs `warn manifest.refresh_failed { reason: "unknown_provider", agent_id }` and retains the previously-cached manifest.

- [ ] **Step 1: Write the failing registration test**

Append this test to `tests/integration/registration.test.ts` inside the `describe("POST /apps/register", ...)` block:

```ts
  it("rejects a manifest whose agent references an unconfigured provider", async () => {
    const appServer = Bun.serve({
      port: 0,
      fetch: async () =>
        Response.json({
          manifest_version: "1",
          app: { id: "bad-app", name: "b", description: "b" },
          agents: [
            {
              id: "bad-bot",
              name: "Bad",
              description: "d",
              system_prompt: "x",
              provider: "openrouter",
              tools: [],
              skills: [],
            },
          ],
        }),
    });
    try {
      const app = buildApp({ config: baseCfg(), store });
      const res = await app.fetch(
        new Request("http://x/apps/register", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer reg" },
          body: JSON.stringify({ id: "bad-app", base_url: `http://localhost:${appServer.port}` }),
        }),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.error.code).toBe("unknown_provider");
      expect(body.error.message).toMatch(/bad-bot.*openrouter.*anthropic/);
      expect(store.getApp("bad-app")).toBeNull();
    } finally {
      appServer.stop();
    }
  });
```

Notes on the test:
- `baseCfg()` in this file already has only the `anthropic` provider configured (via Task 1's edits), so `"openrouter"` is unconfigured.
- `buildApp` is the same helper the file already imports; if not imported yet, add: `import { buildApp } from "../../src/server.ts";` at the top.
- The `expect(store.getApp("bad-app")).toBeNull()` line proves the write was rejected atomically.

- [ ] **Step 2: Run the test to see it fail**

Run: `bun test tests/integration/registration.test.ts`
Expected: FAIL — the manifest is accepted, `res.status` is 201, not 400.

- [ ] **Step 3: Add provider validation in `src/routes/registration.ts`**

At the top of the file, add `Manifest` to the imports:

```ts
import type { Manifest } from "../registry/schema.ts";
```

Then inside `registrationRoutes`, add this helper near the top of the function body (right after `const app = new Hono();`):

```ts
  function validateProviders(
    manifest: Manifest,
  ): { ok: true } | { ok: false; agentId: string; provider: string } {
    for (const a of manifest.agents) {
      if (a.provider && !deps.config.providers[a.provider]) {
        return { ok: false, agentId: a.id, provider: a.provider };
      }
    }
    return { ok: true };
  }
```

Then in the `/register` handler, after `if (manifest.app.id !== body.id)` fails, add the provider check before the `deps.store.upsertApp(...)` call:

```ts
        const check = validateProviders(manifest);
        if (!check.ok) {
          return c.json(
            {
              error: {
                type: "invalid_request_error",
                code: "unknown_provider",
                message: `agent "${check.agentId}" references unknown provider "${check.provider}"; configured: [${Object.keys(deps.config.providers).join(", ")}]`,
              },
            },
            400,
          );
        }
```

Apply the same check to the `/:id/refresh-manifest` handler between `const manifest = await fetchManifest(...)` and `deps.store.upsertApp(...)`.

- [ ] **Step 4: Run the registration tests to see them pass**

Run: `bun test tests/integration/registration.test.ts`
Expected: all pass, including the new one.

- [ ] **Step 5: Write the failing refresher test**

Append to `tests/integration/refresher.test.ts` inside the existing top-level `describe` block. The test uses `ttlMs: 0` to force every entry to look stale — no DB manipulation needed.

```ts
  it("logs warning and keeps stale manifest when a refresh references an unknown provider", async () => {
    const goodManifest = {
      manifest_version: "1" as const,
      app: { id: "shifting-app", name: "s", description: "s" },
      agents: [
        {
          id: "shifting-bot",
          name: "S",
          description: "d",
          system_prompt: "x",
          tools: [],
          skills: [],
        },
      ],
    };
    let handoff: any = goodManifest;
    const appServer = Bun.serve({ port: 0, fetch: async () => Response.json(handoff) });
    const warnings: Array<{ evt: string; fields: any }> = [];
    const logger = {
      debug: () => {},
      info: () => {},
      warn: (evt: string, fields: any) => warnings.push({ evt, fields }),
      error: () => {},
    };
    try {
      store.upsertApp({
        id: "shifting-app",
        base_url: `http://localhost:${appServer.port}`,
        app_token: "tok",
        manifest: goodManifest,
      });
      // Swap the served manifest to one referencing an unknown provider.
      handoff = {
        ...goodManifest,
        agents: [{ ...goodManifest.agents[0], provider: "openrouter" }],
      };

      const handle = startBackgroundRefresh({
        store,
        logger: logger as any,
        ttlMs: 0,          // every entry is instantly stale
        intervalMs: 5,
        config: {
          providers: {
            anthropic: {
              name: "anthropic",
              apiKey: "ak",
              baseUrl: "https://api.anthropic.com",
            },
          },
        },
      });
      // Give the refresher one tick.
      await new Promise((r) => setTimeout(r, 25));
      handle.stop();

      const stored = store.getApp("shifting-app");
      expect(stored?.manifest?.agents[0].provider).toBeUndefined();
      const warn = warnings.find(
        (w) => w.evt === "manifest.refresh_failed" && w.fields.reason === "unknown_provider",
      );
      expect(warn).toBeDefined();
      expect(warn?.fields.agent_id).toBe("shifting-bot");
    } finally {
      appServer.stop();
    }
  });
```

If `startBackgroundRefresh` and `createStore` are not yet imported at the top of the file, add:

```ts
import { startBackgroundRefresh } from "../../src/registry/refresher.ts";
import { createStore, type Store } from "../../src/registry/store.ts";
```

And provide a `store` fixture (`beforeEach` / `afterEach`) per the file's existing pattern if none is defined.

- [ ] **Step 6: Run the refresher tests to see them fail**

Run: `bun test tests/integration/refresher.test.ts`
Expected: FAIL — the refresher accepts the manifest with the unknown provider and overwrites the stored one.

- [ ] **Step 7: Update the refresher to validate providers**

Modify `src/registry/refresher.ts`. At the top, import `Config`:

```ts
import type { Config } from "../config.ts";
```

Change the exported function signature to accept `config`:

```ts
export function startBackgroundRefresh(opts: {
  store: Store;
  logger: Logger;
  ttlMs: number;
  intervalMs: number;
  config: Pick<Config, "providers">;
}): RefresherHandle {
```

Inside the `tick` function, after `const manifest = await fetchManifest(...)` and before `opts.store.upsertApp(...)`, add:

```ts
        const bad = manifest.agents.find(
          (a) => a.provider && !opts.config.providers[a.provider],
        );
        if (bad) {
          opts.logger.warn("manifest.refresh_failed", {
            app_id: app.id,
            agent_id: bad.id,
            reason: "unknown_provider",
            provider: bad.provider,
          });
          continue;
        }
```

- [ ] **Step 8: Update the refresher's caller in `src/server.ts`**

`src/server.ts` calls `startBackgroundRefresh` inside the `if (import.meta.main)` block at lines 34-39. Change the call from:

```ts
  startBackgroundRefresh({
    store,
    logger,
    ttlMs: config.manifestCacheTtlMs,
    intervalMs: 30000,
  });
```

to:

```ts
  startBackgroundRefresh({
    store,
    logger,
    ttlMs: config.manifestCacheTtlMs,
    intervalMs: 30000,
    config,
  });
```

- [ ] **Step 9: Run the refresher tests to see them pass**

Run: `bun test tests/integration/refresher.test.ts`
Expected: all pass, including the new one.

- [ ] **Step 10: Run the full test suite and typecheck**

Run: `bun test`
Expected: 107ish pass / 1 skip / 0 fail.

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 11: Commit**

```bash
git add src/routes/registration.ts src/registry/refresher.ts src/server.ts tests/integration/registration.test.ts tests/integration/refresher.test.ts
git commit -m "$(cat <<'EOF'
feat(registry): validate agent.provider references at register + refresh time

Registration rejects manifests referencing unconfigured providers with
400/unknown_provider. Background refresher warns and retains stale on the
same failure, matching the existing stale-on-error policy.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Concurrency isolation integration test

**Files:**
- Create: `tests/integration/multi-provider-concurrency.test.ts`

**Interfaces:**
- Consumes: `runAgentStream`, `createStore`, `spinUpFakeAnthropic`, `Config`.
- Produces: a test that proves concurrent requests targeting different providers land on their respective backends.

- [ ] **Step 1: Write the concurrency test**

Create `tests/integration/multi-provider-concurrency.test.ts` with:

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createStore, type Store } from "../../src/registry/store.ts";
import { runAgentStream } from "../../src/agent/runner.ts";
import { spinUpFakeAnthropic } from "../helpers/fake-anthropic.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;
let store: Store;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "iri-concurrency-"));
  store = createStore({ dbPath: ":memory:" });
});
afterEach(async () => {
  store.close();
  await rm(tmp, { recursive: true, force: true });
});

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let s = "";
  for await (const x of stream) s += x;
  return s;
}

describe("multi-provider concurrency", () => {
  it("routes concurrent requests to their own provider's baseUrl", async () => {
    const fakeA = spinUpFakeAnthropic({ turns: [{ kind: "text", text: "FROM_A" }] });
    const fakeB = spinUpFakeAnthropic({ turns: [{ kind: "text", text: "FROM_B" }] });
    try {
      const commonManifestFields = {
        manifest_version: "1" as const,
        app: { id: "concurrent-app", name: "c", description: "c" },
      };
      store.upsertApp({
        id: "app-a",
        base_url: "http://unused",
        app_token: "tok-a",
        manifest: {
          ...commonManifestFields,
          app: { ...commonManifestFields.app, id: "app-a" },
          agents: [
            {
              id: "bot-a",
              name: "A",
              description: "d",
              system_prompt: "you are A",
              provider: "provider-a",
              tools: [],
              skills: [],
            } as any,
          ],
        },
      });
      store.upsertApp({
        id: "app-b",
        base_url: "http://unused",
        app_token: "tok-b",
        manifest: {
          ...commonManifestFields,
          app: { ...commonManifestFields.app, id: "app-b" },
          agents: [
            {
              id: "bot-b",
              name: "B",
              description: "d",
              system_prompt: "you are B",
              provider: "provider-b",
              tools: [],
              skills: [],
            } as any,
          ],
        },
      });

      const config = {
        defaultModel: "claude-sonnet-4-6",
        tmpDir: tmp,
        maxAgentTurns: 5,
        toolCallTimeoutMs: 1000,
        providers: {
          "provider-a": {
            name: "provider-a",
            apiKey: "ak-a",
            baseUrl: `http://localhost:${fakeA.port}`,
          },
          "provider-b": {
            name: "provider-b",
            apiKey: "ak-b",
            baseUrl: `http://localhost:${fakeB.port}`,
          },
        },
        defaultProvider: "provider-a",
      };

      const [outA, outB] = await Promise.all([
        collect(
          runAgentStream({
            config,
            store,
            request: {
              requestId: "01A",
              agentId: "bot-a",
              model: null,
              messages: [{ role: "user", content: "hi from A" }],
              showToolCalls: false,
            },
          }),
        ),
        collect(
          runAgentStream({
            config,
            store,
            request: {
              requestId: "01B",
              agentId: "bot-b",
              model: null,
              messages: [{ role: "user", content: "hi from B" }],
              showToolCalls: false,
            },
          }),
        ),
      ]);

      expect(outA).toContain("FROM_A");
      expect(outA).not.toContain("FROM_B");
      expect(outB).toContain("FROM_B");
      expect(outB).not.toContain("FROM_A");
    } finally {
      fakeA.stop();
      fakeB.stop();
    }
  });
});
```

- [ ] **Step 2: Run the test to confirm it passes**

Run: `bun test tests/integration/multi-provider-concurrency.test.ts`
Expected: PASS. (It passes because Task 1 replaced `process.env` mutation with the SDK's per-call `env` option, which isolates credentials per query.)

If it fails with cross-contamination, that means the SDK is not applying `options.env` per-query as documented — fall back to the design's mutex approach: wrap the `sdkOptions` construction and `query(...)` call in `src/agent/runner.ts` in an async mutex that also snapshots+restores `process.env.ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` around each stream setup. Re-run this test; it must pass.

- [ ] **Step 3: Run the full test suite and typecheck**

Run: `bun test`
Expected: 108ish pass / 1 skip / 0 fail.

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/multi-provider-concurrency.test.ts
git commit -m "$(cat <<'EOF'
test: prove concurrent requests to different providers stay isolated

Two agents pointing at two providers backed by two fake Anthropic servers;
Promise.all runs both chat streams concurrently. Each request must contain
its own provider's marker and not the other's.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Per-provider default models — config, runner, /v1/models

*(Added 2026-07-25 per design v2.)*

**Files:**
- Modify: `src/config.ts`
- Modify: `src/agent/runner.ts`
- Modify: `src/routes/openai.ts`
- Modify: `tests/setup.ts`
- Modify: `tests/unit/config.test.ts`
- Modify: `tests/integration/models.test.ts`
- Modify: `tests/integration/runner.test.ts`

**Interfaces:**
- Produces: `Provider.defaultModel: string` (required). `Config.defaultModel` REMOVED. Model chain in the runner becomes `request.model || agent?.default_model || provider.defaultModel`, where `provider` is the already-resolved routed provider. `/v1/models` returns exactly `[providers[defaultProvider].defaultModel]` — the hardcoded `claude-opus-4-8` / `claude-haiku-4-5` entries are dropped.

- [ ] **Step 1: Write failing config tests** — extend `tests/unit/config.test.ts`: provider parses `IRI_PROVIDER_<NAME>_DEFAULT_MODEL` into `defaultModel`; missing `_DEFAULT_MODEL` throws the half-configured error naming that suffix; presence of legacy `IRI_DEFAULT_MODEL` throws `"IRI_DEFAULT_MODEL is no longer supported; set IRI_PROVIDER_<NAME>_DEFAULT_MODEL per provider"`; `cfg.defaultModel` no longer exists (type-level: remove all expectations on it). Update `baseEnv()` fixtures to include `IRI_PROVIDER_ANTHROPIC_DEFAULT_MODEL`.

- [ ] **Step 2: Run config tests to see them fail** — `bun test tests/unit/config.test.ts`

- [ ] **Step 3: Implement in `src/config.ts`** — widen `PROVIDER_KEY_RE` to `(API_KEY|BASE_URL|DEFAULT_MODEL)`, require all three per discovered name, drop `defaultModel` from `Config`, add the legacy-var guard.

- [ ] **Step 4: Update `tests/setup.ts`** — add `IRI_PROVIDER_ANTHROPIC_DEFAULT_MODEL=claude-opus-5`; remove any `IRI_DEFAULT_MODEL`.

- [ ] **Step 5: Write failing runner test** — agent with `provider` set but no `default_model` resolves to the *routed* provider's `defaultModel` (register two providers with distinct defaults to prove it's not the gateway default); `request.model` still wins over everything.

- [ ] **Step 6: Update `src/agent/runner.ts`** — replace `config.defaultModel` fallback with `provider.defaultModel`; ensure provider resolution happens before model resolution.

- [ ] **Step 7: Update `/v1/models` in `src/routes/openai.ts`** — return only the default provider's `defaultModel`; update `tests/integration/models.test.ts` accordingly.

- [ ] **Step 8: Run the full test suite and typecheck** — `bun test` green, `bun run typecheck` clean. Grep `defaultModel` in `src/` to confirm the only remaining references are `Provider.defaultModel`.

- [ ] **Step 9: Commit**

```bash
git add src/config.ts src/agent/runner.ts src/routes/openai.ts tests/
git commit -m "$(cat <<'EOF'
feat(config): require per-provider default model, remove global IRI_DEFAULT_MODEL

Each provider now carries IRI_PROVIDER_<NAME>_DEFAULT_MODEL. The runner's
model chain falls through request.model -> agent.default_model ->
routed provider's defaultModel, so an agent that picks a provider without
pinning a model always gets a model that provider serves. /v1/models
advertises only the default provider's default model.
EOF
)"
```

---

## Task 6: Docs — .env.example, README, examples/weather-app

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `examples/weather-app/README.md`

**Interfaces:**
- Consumes: nothing at runtime.
- Produces: operator-facing documentation for the new provider config surface.

- [ ] **Step 1: Rewrite `.env.example`**

Replace the entire contents with:

```
# Required
IRI_API_KEY=
IRI_REGISTRATION_SECRET=

# Providers — configure one or more. Name is arbitrary uppercase alphanumeric.
# Each provider requires all three vars: API_KEY, BASE_URL, DEFAULT_MODEL.
IRI_PROVIDER_ANTHROPIC_API_KEY=
IRI_PROVIDER_ANTHROPIC_BASE_URL=https://api.anthropic.com
IRI_PROVIDER_ANTHROPIC_DEFAULT_MODEL=claude-opus-5

# Example: OpenRouter via its Anthropic-compat endpoint (any model it serves).
# IRI_PROVIDER_OPENROUTER_API_KEY=sk-or-...
# IRI_PROVIDER_OPENROUTER_BASE_URL=https://openrouter.ai/api/v1/anthropic
# IRI_PROVIDER_OPENROUTER_DEFAULT_MODEL=moonshotai/kimi-k3

# Example: local LM Studio (API key required non-empty but unused).
# IRI_PROVIDER_LMSTUDIO_API_KEY=lm-studio
# IRI_PROVIDER_LMSTUDIO_BASE_URL=http://localhost:1234
# IRI_PROVIDER_LMSTUDIO_DEFAULT_MODEL=ornith-1.0-35b

# Which provider handles vanilla requests (no iri_agent) and agents that omit `provider`.
# Optional if exactly one provider is configured; required otherwise.
IRI_DEFAULT_PROVIDER=anthropic

# Optional with defaults
IRI_PORT=4000
IRI_MAX_AGENT_TURNS=20
IRI_TOOL_CALL_TIMEOUT_MS=30000
IRI_MANIFEST_CACHE_TTL_MS=300000
IRI_REQUEST_TIMEOUT_MS=300000
IRI_DB_PATH=./iriguchi.db
IRI_TMP_DIR=./.iri-tmp
```

- [ ] **Step 2: Add a "Providers" section to `README.md`**

Insert this section into `README.md` between the "Quickstart" section and the "Generic OpenAI client usage" section:

```markdown
## Providers

Iriguchi routes each request to a named Anthropic-shaped backend. Configure providers via env vars:

```bash
IRI_PROVIDER_ANTHROPIC_API_KEY=sk-ant-...
IRI_PROVIDER_ANTHROPIC_BASE_URL=https://api.anthropic.com
IRI_PROVIDER_ANTHROPIC_DEFAULT_MODEL=claude-opus-5

IRI_PROVIDER_OPENROUTER_API_KEY=sk-or-...
IRI_PROVIDER_OPENROUTER_BASE_URL=https://openrouter.ai/api/v1/anthropic
IRI_PROVIDER_OPENROUTER_DEFAULT_MODEL=moonshotai/kimi-k3

IRI_DEFAULT_PROVIDER=anthropic
```

Only providers speaking the Anthropic `/v1/messages` API are supported today (Anthropic direct, OpenRouter's Anthropic endpoint, LM Studio ≥ 0.4.1, Ollama ≥ 0.14.0, Bedrock/Vertex Claude, or any Anthropic-compat proxy) — but any model behind such an endpoint works, not just Claude. Non-Anthropic-shaped providers (raw OpenAI shape) are out of scope for v1.

Agents opt into a non-default provider in their manifest:

```json
{
  "agents": [
    {
      "id": "weather-bot",
      "provider": "openrouter",
      "default_model": "moonshotai/kimi-k3",
      ...
    }
  ]
}
```

Model names are pass-through: write the string your provider expects. An agent that omits `default_model` inherits its routed provider's `DEFAULT_MODEL`. Registration rejects manifests that reference unconfigured providers.
```

- [ ] **Step 3: Update `examples/weather-app/README.md`**

Find the run instructions (currently lines 8-13) and replace the gateway startup block:

```markdown
1. Start the gateway in one terminal:
   ```bash
   IRI_API_KEY=mykey \
   IRI_REGISTRATION_SECRET=regsecret \
   ANTHROPIC_API_KEY=sk-... \
   bun run dev
   ```
```

with:

```markdown
1. Start the gateway in one terminal:
   ```bash
   IRI_API_KEY=mykey \
   IRI_REGISTRATION_SECRET=regsecret \
   IRI_PROVIDER_ANTHROPIC_API_KEY=sk-... \
   IRI_PROVIDER_ANTHROPIC_BASE_URL=https://api.anthropic.com \
   bun run dev
   ```
```

- [ ] **Step 4: Run the full test suite and typecheck (docs shouldn't move anything, but confirm)**

Run: `bun test`
Expected: same green count as end of Task 5.

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add .env.example README.md examples/weather-app/README.md
git commit -m "$(cat <<'EOF'
docs: document IRI_PROVIDER_* env-var pattern and agent.provider field

.env.example rewritten around the provider registry. README gains a
Providers section explaining the Anthropic-shaped-only scope, how agents
opt into a non-default provider, and pass-through model naming.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

- [ ] **Step 1: Full test suite green**

Run: `bun test`
Expected: 108ish pass / 1 skip / 0 fail.

- [ ] **Step 2: Typecheck clean**

Run: `bun run typecheck`
Expected: exit 0, no output.

- [ ] **Step 3: Grep confirms no stale references**

Run: `grep -rn "anthropicApiKey\|anthropicBaseUrl\|ANTHROPIC_API_KEY\|ANTHROPIC_BASE_URL\|IRI_DEFAULT_MODEL\|config.defaultModel" src tests examples/weather-app 2>/dev/null || true`
Expected: only matches inside `.env.example` template (if any comment mentions it), any historical spec/plan doc references, and the intentional legacy-var guard in `src/config.ts` (the `IRI_DEFAULT_MODEL is no longer supported` error message). No other live code should reference the old names.

- [ ] **Step 4: Manual sanity — startup**

Optional local check (not automated; only run if convenient): with a real `.env` populated per the new pattern, `bun run dev` starts the gateway and prints its listen line. Not a plan-blocking step.
