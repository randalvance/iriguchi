# Iriguchi AI Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Bun/Hono AI gateway (`iriguchi`) that exposes an OpenAI-compatible chat API, runs Claude Agent SDK agents against per-app dynamic manifests with `api_call` tools and Claude-Code-style skills, and ships a working demo app.

**Architecture:** Single Bun process running Hono. SQLite for app/manifest registry. Per-request: resolve `iri_agent` → fetch cached manifest → materialize skills to tempdir → build in-process MCP tool server → invoke `@anthropic-ai/claude-agent-sdk` `query()` → translate SDK stream to OpenAI SSE.

**Tech Stack:** Bun, Hono, Zod, `@anthropic-ai/claude-agent-sdk`, `bun:sqlite`, `ulid`. Tests via `bun test`.

**Spec:** `docs/superpowers/specs/2026-06-01-iriguchi-ai-gateway-design.md` — read it first.

**Conventions used throughout:**
- TDD: every task writes the failing test first, watches it fail, implements, watches it pass, commits.
- All files kept under ~200 LOC; split if growth is organic.
- Custom (non-OpenAI-standard) request fields are prefixed `iri_`.
- One commit per task. Commit messages are conventional (`feat:`, `test:`, `chore:`, `docs:`).
- Imports use Bun-native specifiers (`bun:test`, `bun:sqlite`) where applicable.

---

## Task 0: Project initialization

**Files:**
- Create: `package.json`
- Create: `bunfig.toml`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `src/.keep`, `tests/unit/.keep`, `tests/integration/.keep`, `tests/e2e/.keep`

- [ ] **Step 1: Initialize Bun project**

Run:
```bash
cd /Users/randal/dev/iriguchi
bun init -y
```

This creates `package.json`, `tsconfig.json`, `bunfig.toml`, `.gitignore`, `index.ts`, `README.md`. We'll overwrite most of these.

- [ ] **Step 2: Replace `package.json`**

Write `package.json`:
```json
{
  "name": "iriguchi",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "module": "src/server.ts",
  "scripts": {
    "dev": "bun --hot src/server.ts",
    "start": "bun src/server.ts",
    "test": "bun test --timeout 30000",
    "test:e2e": "IRI_E2E=1 bun test tests/e2e --timeout 120000",
    "typecheck": "bunx tsc --noEmit"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "latest",
    "hono": "^4.0.0",
    "ulid": "^2.3.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 3: Install dependencies**

Run:
```bash
bun install
```
Expected: `bun.lock` (or `bun.lockb`) created, no errors.

- [ ] **Step 4: Replace `tsconfig.json`**

Write `tsconfig.json`:
```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "ESNext",
    "moduleDetection": "force",
    "jsx": "preserve",
    "allowJs": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "noPropertyAccessFromIndexSignature": false,
    "types": ["bun-types"]
  },
  "include": ["src/**/*", "tests/**/*", "examples/**/*"]
}
```

- [ ] **Step 5: Replace `bunfig.toml`**

Write `bunfig.toml`:
```toml
[test]
preload = ["./tests/setup.ts"]
```

- [ ] **Step 6: Create test setup file**

Write `tests/setup.ts`:
```typescript
// Ensure deterministic env for tests
process.env.IRI_API_KEY ||= "test-api-key";
process.env.IRI_REGISTRATION_SECRET ||= "test-registration-secret";
process.env.ANTHROPIC_API_KEY ||= "test-anthropic-key";
process.env.IRI_DEFAULT_MODEL ||= "claude-sonnet-4-6";
process.env.IRI_DB_PATH ||= ":memory:";
```

- [ ] **Step 7: Replace `.gitignore`**

Write `.gitignore`:
```
node_modules/
*.log
.env
.env.local
.env.test
*.db
*.db-journal
*.db-wal
*.db-shm
.DS_Store
dist/
build/
coverage/
.iri-tmp/
```

- [ ] **Step 8: Create `.env.example`**

Write `.env.example`:
```
# Required
ANTHROPIC_API_KEY=
IRI_API_KEY=
IRI_REGISTRATION_SECRET=

# Optional with defaults
IRI_PORT=4000
IRI_DEFAULT_MODEL=claude-sonnet-4-6
IRI_MAX_AGENT_TURNS=20
IRI_TOOL_CALL_TIMEOUT_MS=30000
IRI_MANIFEST_CACHE_TTL_MS=300000
IRI_REQUEST_TIMEOUT_MS=300000
IRI_DB_PATH=./iriguchi.db
IRI_TMP_DIR=./.iri-tmp

# For local LLM (e.g., Ollama, LM Studio); leave unset for Anthropic cloud
# ANTHROPIC_BASE_URL=
```

- [ ] **Step 9: Create directory placeholders**

Run:
```bash
mkdir -p src/routes src/agent src/registry tests/unit tests/integration tests/e2e
touch src/.keep tests/unit/.keep tests/integration/.keep tests/e2e/.keep
```

- [ ] **Step 10: Delete the stray init artifacts**

Run:
```bash
rm -f index.ts
```
(Keep the existing `README.md` — we replace it in the final task.)

- [ ] **Step 11: Verify project builds**

Run:
```bash
bun run typecheck
```
Expected: no errors (no source files yet, so nothing to typecheck — should exit 0).

- [ ] **Step 12: Commit**

```bash
git add package.json tsconfig.json bunfig.toml .gitignore .env.example tests/setup.ts src/.keep tests/unit/.keep tests/integration/.keep tests/e2e/.keep bun.lock
git commit -m "chore: bootstrap bun/hono project skeleton"
```

(If `bun.lock` doesn't exist, use `bun.lockb` instead.)

---

## Task 1: Config module

Loads env vars, validates required ones, exposes a typed config object.

**Files:**
- Create: `src/config.ts`
- Create: `tests/unit/config.test.ts`

- [ ] **Step 1: Write the failing test**

Write `tests/unit/config.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from "bun:test";
import { loadConfig } from "../../src/config.ts";

describe("loadConfig", () => {
  const baseEnv = {
    ANTHROPIC_API_KEY: "ak-test",
    IRI_API_KEY: "client-key",
    IRI_REGISTRATION_SECRET: "reg-secret",
  };

  it("returns defaults for optional vars", () => {
    const cfg = loadConfig(baseEnv);
    expect(cfg.port).toBe(4000);
    expect(cfg.defaultModel).toBe("claude-sonnet-4-6");
    expect(cfg.maxAgentTurns).toBe(20);
    expect(cfg.toolCallTimeoutMs).toBe(30000);
    expect(cfg.manifestCacheTtlMs).toBe(300000);
    expect(cfg.requestTimeoutMs).toBe(300000);
    expect(cfg.dbPath).toBe("./iriguchi.db");
    expect(cfg.tmpDir).toBe("./.iri-tmp");
    expect(cfg.anthropicBaseUrl).toBeUndefined();
    expect(cfg.anthropicApiKey).toBe("ak-test");
    expect(cfg.apiKey).toBe("client-key");
    expect(cfg.registrationSecret).toBe("reg-secret");
  });

  it("honors overrides for optional vars", () => {
    const cfg = loadConfig({
      ...baseEnv,
      IRI_PORT: "5050",
      IRI_DEFAULT_MODEL: "claude-opus-4-8",
      IRI_MAX_AGENT_TURNS: "5",
      IRI_TOOL_CALL_TIMEOUT_MS: "1000",
      IRI_MANIFEST_CACHE_TTL_MS: "60000",
      IRI_REQUEST_TIMEOUT_MS: "120000",
      IRI_DB_PATH: "/tmp/foo.db",
      IRI_TMP_DIR: "/tmp/iri",
      ANTHROPIC_BASE_URL: "http://localhost:11434",
    });
    expect(cfg.port).toBe(5050);
    expect(cfg.defaultModel).toBe("claude-opus-4-8");
    expect(cfg.maxAgentTurns).toBe(5);
    expect(cfg.anthropicBaseUrl).toBe("http://localhost:11434");
  });

  it.each(["ANTHROPIC_API_KEY", "IRI_API_KEY", "IRI_REGISTRATION_SECRET"])(
    "throws if required var %s is missing",
    (name) => {
      const env = { ...baseEnv } as Record<string, string>;
      delete env[name];
      expect(() => loadConfig(env)).toThrow(name);
    },
  );

  it("throws on non-numeric numeric vars", () => {
    expect(() => loadConfig({ ...baseEnv, IRI_PORT: "not-a-number" })).toThrow(
      /IRI_PORT/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
bun test tests/unit/config.test.ts
```
Expected: FAIL — `loadConfig` doesn't exist.

- [ ] **Step 3: Implement `src/config.ts`**

Write `src/config.ts`:
```typescript
export type Config = {
  port: number;
  defaultModel: string;
  maxAgentTurns: number;
  toolCallTimeoutMs: number;
  manifestCacheTtlMs: number;
  requestTimeoutMs: number;
  dbPath: string;
  tmpDir: string;
  anthropicApiKey: string;
  anthropicBaseUrl: string | undefined;
  apiKey: string;
  registrationSecret: string;
};

const REQUIRED = ["ANTHROPIC_API_KEY", "IRI_API_KEY", "IRI_REGISTRATION_SECRET"] as const;

function intVar(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`Invalid integer for ${key}: ${raw}`);
  }
  return n;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  for (const name of REQUIRED) {
    if (!env[name]) throw new Error(`Missing required env var: ${name}`);
  }
  return {
    port: intVar(env, "IRI_PORT", 4000),
    defaultModel: env.IRI_DEFAULT_MODEL || "claude-sonnet-4-6",
    maxAgentTurns: intVar(env, "IRI_MAX_AGENT_TURNS", 20),
    toolCallTimeoutMs: intVar(env, "IRI_TOOL_CALL_TIMEOUT_MS", 30000),
    manifestCacheTtlMs: intVar(env, "IRI_MANIFEST_CACHE_TTL_MS", 300000),
    requestTimeoutMs: intVar(env, "IRI_REQUEST_TIMEOUT_MS", 300000),
    dbPath: env.IRI_DB_PATH || "./iriguchi.db",
    tmpDir: env.IRI_TMP_DIR || "./.iri-tmp",
    anthropicApiKey: env.ANTHROPIC_API_KEY!,
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL || undefined,
    apiKey: env.IRI_API_KEY!,
    registrationSecret: env.IRI_REGISTRATION_SECRET!,
  };
}
```

- [ ] **Step 4: Run tests**

Run:
```bash
bun test tests/unit/config.test.ts
```
Expected: PASS — all 6 cases green.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/unit/config.test.ts
git commit -m "feat: add config loader with env var validation"
```

---

## Task 2: Logger

Structured JSON logger with request_id binding.

**Files:**
- Create: `src/logger.ts`
- Create: `tests/unit/logger.test.ts`

- [ ] **Step 1: Write the failing test**

Write `tests/unit/logger.test.ts`:
```typescript
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { createLogger, type LogEvent } from "../../src/logger.ts";

function captureLogger() {
  const events: LogEvent[] = [];
  const sink = (e: LogEvent) => events.push(e);
  return { events, sink };
}

describe("logger", () => {
  it("emits JSON with event, level, timestamp", () => {
    const { events, sink } = captureLogger();
    const log = createLogger({ sink });
    log.info("request.start", { method: "POST", path: "/v1/chat/completions" });
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("request.start");
    expect(events[0].level).toBe("info");
    expect(events[0].method).toBe("POST");
    expect(events[0].path).toBe("/v1/chat/completions");
    expect(typeof events[0].ts).toBe("number");
  });

  it("propagates bound fields via .with(...)", () => {
    const { events, sink } = captureLogger();
    const log = createLogger({ sink });
    const child = log.with({ request_id: "01H123" });
    child.info("agent.turn", { turn: 1 });
    expect(events[0].request_id).toBe("01H123");
    expect(events[0].turn).toBe(1);
    expect(events[0].event).toBe("agent.turn");
  });

  it("levels: info, warn, error", () => {
    const { events, sink } = captureLogger();
    const log = createLogger({ sink });
    log.info("a", {});
    log.warn("b", {});
    log.error("c", { err: "boom" });
    expect(events.map((e) => e.level)).toEqual(["info", "warn", "error"]);
  });

  it("default sink writes JSON line to stdout", () => {
    let captured = "";
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (s: string) => {
      captured += s;
      return true;
    };
    try {
      const log = createLogger();
      log.info("test.evt", { x: 1 });
    } finally {
      (process.stdout as any).write = orig;
    }
    const line = captured.trim();
    const parsed = JSON.parse(line);
    expect(parsed.event).toBe("test.evt");
    expect(parsed.x).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
bun test tests/unit/logger.test.ts
```
Expected: FAIL — `createLogger` doesn't exist.

- [ ] **Step 3: Implement `src/logger.ts`**

Write `src/logger.ts`:
```typescript
export type LogLevel = "info" | "warn" | "error";

export type LogEvent = {
  event: string;
  level: LogLevel;
  ts: number;
  [key: string]: unknown;
};

export type Logger = {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  with(extra: Record<string, unknown>): Logger;
};

type Sink = (e: LogEvent) => void;

const defaultSink: Sink = (e) => {
  process.stdout.write(JSON.stringify(e) + "\n");
};

export function createLogger(opts: { sink?: Sink; bound?: Record<string, unknown> } = {}): Logger {
  const sink = opts.sink || defaultSink;
  const bound = opts.bound || {};
  const emit = (level: LogLevel, event: string, fields: Record<string, unknown> = {}) => {
    sink({ event, level, ts: Date.now(), ...bound, ...fields });
  };
  return {
    info: (e, f) => emit("info", e, f),
    warn: (e, f) => emit("warn", e, f),
    error: (e, f) => emit("error", e, f),
    with: (extra) => createLogger({ sink, bound: { ...bound, ...extra } }),
  };
}
```

- [ ] **Step 4: Run tests**

Run:
```bash
bun test tests/unit/logger.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/logger.ts tests/unit/logger.test.ts
git commit -m "feat: add structured JSON logger with field binding"
```

---

## Task 3: Manifest Zod schemas

Validates the `/agents-manifest` response from registered apps.

**Files:**
- Create: `src/registry/schema.ts`
- Create: `tests/unit/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Write `tests/unit/schema.test.ts`:
```typescript
import { describe, it, expect } from "bun:test";
import { ManifestSchema } from "../../src/registry/schema.ts";

const VALID_MANIFEST = {
  manifest_version: "1",
  app: {
    id: "weather-app",
    name: "Weather App",
    description: "Provides weather forecasts and alerts",
  },
  agents: [
    {
      id: "weather-bot",
      name: "Weather Bot",
      description: "Answers weather questions",
      system_prompt: "You are a helpful weather assistant.",
      default_model: "claude-sonnet-4-6",
      tools: [
        {
          type: "api_call",
          name: "get_forecast",
          description: "Get the weather forecast for a location",
          parameters: {
            type: "object",
            properties: {
              location: { type: "string" },
              days: { type: "integer", minimum: 1, maximum: 7 },
            },
            required: ["location"],
          },
          endpoint: { method: "POST", path: "/api/forecast" },
          timeout_ms: 30000,
        },
      ],
      skills: [
        {
          name: "weather-jargon",
          content: "---\nname: weather-jargon\ndescription: jargon\n---\n\nbody",
        },
      ],
    },
  ],
};

describe("ManifestSchema", () => {
  it("accepts a fully populated valid manifest", () => {
    const parsed = ManifestSchema.parse(VALID_MANIFEST);
    expect(parsed.agents[0].id).toBe("weather-bot");
  });

  it("accepts omission of optional agent fields (default_model, tools, skills)", () => {
    const m = structuredClone(VALID_MANIFEST);
    delete (m.agents[0] as any).default_model;
    m.agents[0].tools = [];
    m.agents[0].skills = [];
    expect(() => ManifestSchema.parse(m)).not.toThrow();
  });

  it("accepts url-based skills", () => {
    const m = structuredClone(VALID_MANIFEST);
    m.agents[0].skills = [
      { name: "weather-jargon", url: "https://example.com/skill.md" } as any,
    ];
    expect(() => ManifestSchema.parse(m)).not.toThrow();
  });

  it("rejects skill that has neither content nor url", () => {
    const m = structuredClone(VALID_MANIFEST);
    m.agents[0].skills = [{ name: "broken" } as any];
    expect(() => ManifestSchema.parse(m)).toThrow();
  });

  it("rejects skill that has both content and url", () => {
    const m = structuredClone(VALID_MANIFEST);
    m.agents[0].skills = [
      { name: "x", content: "y", url: "https://z" } as any,
    ];
    expect(() => ManifestSchema.parse(m)).toThrow();
  });

  it("rejects unknown manifest_version", () => {
    const m = structuredClone(VALID_MANIFEST);
    (m as any).manifest_version = "2";
    expect(() => ManifestSchema.parse(m)).toThrow();
  });

  it("rejects tool with unknown type", () => {
    const m = structuredClone(VALID_MANIFEST);
    (m.agents[0].tools[0] as any).type = "shell";
    expect(() => ManifestSchema.parse(m)).toThrow();
  });

  it("rejects external (absolute URL) endpoint paths in api_call tools", () => {
    const m = structuredClone(VALID_MANIFEST);
    m.agents[0].tools[0].endpoint.path = "https://evil.example.com/api";
    expect(() => ManifestSchema.parse(m)).toThrow(/path/i);
  });

  it("rejects missing required fields (agent.id)", () => {
    const m = structuredClone(VALID_MANIFEST);
    delete (m.agents[0] as any).id;
    expect(() => ManifestSchema.parse(m)).toThrow();
  });

  it("rejects duplicate agent ids within a manifest", () => {
    const m = structuredClone(VALID_MANIFEST);
    m.agents.push(structuredClone(m.agents[0]));
    expect(() => ManifestSchema.parse(m)).toThrow(/duplicate/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
bun test tests/unit/schema.test.ts
```
Expected: FAIL — `ManifestSchema` doesn't exist.

- [ ] **Step 3: Implement `src/registry/schema.ts`**

Write `src/registry/schema.ts`:
```typescript
import { z } from "zod";

const JsonSchemaObject = z.record(z.unknown());

const ApiCallEndpoint = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  // Relative paths only (no scheme, must start with /). Closes the
  // external-URL security surface called out in the spec.
  path: z
    .string()
    .min(1)
    .refine((p) => p.startsWith("/") && !/^https?:\/\//i.test(p), {
      message: "endpoint.path must be a relative path starting with '/'",
    }),
});

const ApiCallTool = z.object({
  type: z.literal("api_call"),
  name: z.string().min(1),
  description: z.string().min(1),
  parameters: JsonSchemaObject,
  endpoint: ApiCallEndpoint,
  timeout_ms: z.number().int().positive().optional(),
});

export const ToolSchema = z.discriminatedUnion("type", [ApiCallTool]);

const SkillSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "skill name must be kebab-case"),
    content: z.string().optional(),
    url: z.string().url().optional(),
  })
  .refine((s) => !!s.content !== !!s.url, {
    message: "skill must have exactly one of content or url",
  });

const AgentSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "agent id must be kebab-case"),
  name: z.string().min(1),
  description: z.string().min(1),
  system_prompt: z.string().min(1),
  default_model: z.string().optional(),
  tools: z.array(ToolSchema).default([]),
  skills: z.array(SkillSchema).default([]),
});

export const ManifestSchema = z
  .object({
    manifest_version: z.literal("1"),
    app: z.object({
      id: z
        .string()
        .min(1)
        .regex(/^[a-z0-9][a-z0-9-]*$/, "app id must be kebab-case"),
      name: z.string().min(1),
      description: z.string().min(1),
    }),
    agents: z.array(AgentSchema),
  })
  .refine(
    (m) => new Set(m.agents.map((a) => a.id)).size === m.agents.length,
    { message: "duplicate agent ids within manifest" },
  );

export type Manifest = z.infer<typeof ManifestSchema>;
export type Agent = z.infer<typeof AgentSchema>;
export type Tool = z.infer<typeof ToolSchema>;
export type Skill = z.infer<typeof SkillSchema>;
```

- [ ] **Step 4: Run tests**

Run:
```bash
bun test tests/unit/schema.test.ts
```
Expected: PASS — all 10 cases green.

- [ ] **Step 5: Typecheck**

Run:
```bash
bun run typecheck
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/registry/schema.ts tests/unit/schema.test.ts
git commit -m "feat: add Zod schemas for app manifest validation"
```

---

## Task 4: SQLite store

Persists registered apps and a denormalized `agents` lookup table.

**Files:**
- Create: `src/registry/store.ts`
- Create: `tests/integration/store.test.ts`

- [ ] **Step 1: Write the failing test**

Write `tests/integration/store.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from "bun:test";
import { createStore, type Store } from "../../src/registry/store.ts";
import type { Manifest } from "../../src/registry/schema.ts";

function fixtureManifest(appId = "weather-app", agentIds = ["weather-bot"]): Manifest {
  return {
    manifest_version: "1",
    app: { id: appId, name: appId, description: appId },
    agents: agentIds.map((id) => ({
      id,
      name: id,
      description: id,
      system_prompt: "p",
      tools: [],
      skills: [],
    })),
  } as Manifest;
}

describe("store", () => {
  let store: Store;

  beforeEach(() => {
    store = createStore({ dbPath: ":memory:" });
  });

  it("upsertApp persists an app with manifest and agents", () => {
    const m = fixtureManifest();
    store.upsertApp({
      id: "weather-app",
      base_url: "http://localhost:4001",
      app_token: "tok-1",
      manifest: m,
    });
    const app = store.getApp("weather-app");
    expect(app?.base_url).toBe("http://localhost:4001");
    expect(app?.app_token).toBe("tok-1");
    expect(app?.manifest?.agents[0].id).toBe("weather-bot");
    expect(app?.manifest_fetched_at).toBeGreaterThan(0);
  });

  it("lookupAgent returns owning app + agent", () => {
    store.upsertApp({
      id: "weather-app",
      base_url: "http://localhost:4001",
      app_token: "tok-1",
      manifest: fixtureManifest(),
    });
    const found = store.lookupAgent("weather-bot");
    expect(found?.app.id).toBe("weather-app");
    expect(found?.agent.id).toBe("weather-bot");
  });

  it("lookupAgent returns null for unknown agent", () => {
    expect(store.lookupAgent("nope")).toBeNull();
  });

  it("replacing manifest re-syncs agents (deletes removed, adds new)", () => {
    store.upsertApp({
      id: "weather-app",
      base_url: "http://localhost:4001",
      app_token: "tok-1",
      manifest: fixtureManifest("weather-app", ["weather-bot", "old-bot"]),
    });
    expect(store.lookupAgent("old-bot")?.app.id).toBe("weather-app");

    store.upsertApp({
      id: "weather-app",
      base_url: "http://localhost:4001",
      app_token: "tok-1",
      manifest: fixtureManifest("weather-app", ["weather-bot", "new-bot"]),
    });
    expect(store.lookupAgent("old-bot")).toBeNull();
    expect(store.lookupAgent("new-bot")?.app.id).toBe("weather-app");
  });

  it("deleteApp cascades to its agents", () => {
    store.upsertApp({
      id: "weather-app",
      base_url: "http://localhost:4001",
      app_token: "tok-1",
      manifest: fixtureManifest(),
    });
    store.deleteApp("weather-app");
    expect(store.getApp("weather-app")).toBeNull();
    expect(store.lookupAgent("weather-bot")).toBeNull();
  });

  it("listApps returns all rows", () => {
    store.upsertApp({
      id: "a",
      base_url: "http://x:1",
      app_token: "t1",
      manifest: fixtureManifest("a"),
    });
    store.upsertApp({
      id: "b",
      base_url: "http://x:2",
      app_token: "t2",
      manifest: fixtureManifest("b"),
    });
    const ids = store.listApps().map((a) => a.id).sort();
    expect(ids).toEqual(["a", "b"]);
  });

  it("rejects agent id reused across apps", () => {
    store.upsertApp({
      id: "a",
      base_url: "http://x:1",
      app_token: "t1",
      manifest: fixtureManifest("a", ["shared-bot"]),
    });
    expect(() =>
      store.upsertApp({
        id: "b",
        base_url: "http://x:2",
        app_token: "t2",
        manifest: fixtureManifest("b", ["shared-bot"]),
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
bun test tests/integration/store.test.ts
```
Expected: FAIL — `createStore` doesn't exist.

- [ ] **Step 3: Implement `src/registry/store.ts`**

Write `src/registry/store.ts`:
```typescript
import { Database } from "bun:sqlite";
import type { Manifest, Agent } from "./schema.ts";

export type StoredApp = {
  id: string;
  base_url: string;
  app_token: string;
  registered_at: number;
  manifest: Manifest | null;
  manifest_fetched_at: number | null;
};

export type AgentLookup = { app: StoredApp; agent: Agent };

export type Store = {
  upsertApp(input: {
    id: string;
    base_url: string;
    app_token: string;
    manifest: Manifest;
  }): void;
  getApp(id: string): StoredApp | null;
  listApps(): StoredApp[];
  lookupAgent(agentId: string): AgentLookup | null;
  deleteApp(id: string): void;
  close(): void;
};

export function createStore(opts: { dbPath: string }): Store {
  const db = new Database(opts.dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS apps (
      id TEXT PRIMARY KEY,
      base_url TEXT NOT NULL,
      app_token TEXT NOT NULL,
      registered_at INTEGER NOT NULL,
      manifest_json TEXT,
      manifest_fetched_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS agents_app_idx ON agents(app_id);
  `);

  const rowToApp = (row: any): StoredApp => ({
    id: row.id,
    base_url: row.base_url,
    app_token: row.app_token,
    registered_at: row.registered_at,
    manifest: row.manifest_json ? (JSON.parse(row.manifest_json) as Manifest) : null,
    manifest_fetched_at: row.manifest_fetched_at,
  });

  const upsertAppStmt = db.prepare(`
    INSERT INTO apps (id, base_url, app_token, registered_at, manifest_json, manifest_fetched_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      base_url = excluded.base_url,
      app_token = excluded.app_token,
      manifest_json = excluded.manifest_json,
      manifest_fetched_at = excluded.manifest_fetched_at
  `);

  const deleteOtherAgentsStmt = db.prepare(
    `DELETE FROM agents WHERE app_id = ? AND id NOT IN (SELECT value FROM json_each(?))`,
  );
  const insertAgentStmt = db.prepare(
    `INSERT OR REPLACE INTO agents (id, app_id) VALUES (?, ?)`,
  );

  return {
    upsertApp(input) {
      const now = Date.now();
      // First, check that no agent id in the new manifest belongs to a different app.
      const conflictStmt = db.prepare(
        `SELECT id FROM agents WHERE id = ? AND app_id != ?`,
      );
      for (const a of input.manifest.agents) {
        const conflict = conflictStmt.get(a.id, input.id) as { id: string } | null;
        if (conflict) {
          throw new Error(`Agent id "${a.id}" is already owned by another app`);
        }
      }
      db.transaction(() => {
        upsertAppStmt.run(
          input.id,
          input.base_url,
          input.app_token,
          now,
          JSON.stringify(input.manifest),
          now,
        );
        const keepIds = JSON.stringify(input.manifest.agents.map((a) => a.id));
        deleteOtherAgentsStmt.run(input.id, keepIds);
        for (const a of input.manifest.agents) {
          insertAgentStmt.run(a.id, input.id);
        }
      })();
    },

    getApp(id) {
      const row = db.query(`SELECT * FROM apps WHERE id = ?`).get(id) as any;
      return row ? rowToApp(row) : null;
    },

    listApps() {
      const rows = db.query(`SELECT * FROM apps`).all() as any[];
      return rows.map(rowToApp);
    },

    lookupAgent(agentId) {
      const row = db
        .query(
          `SELECT apps.* FROM apps
           JOIN agents ON agents.app_id = apps.id
           WHERE agents.id = ?`,
        )
        .get(agentId) as any;
      if (!row) return null;
      const app = rowToApp(row);
      const agent = app.manifest?.agents.find((a) => a.id === agentId);
      if (!agent) return null;
      return { app, agent };
    },

    deleteApp(id) {
      db.query(`DELETE FROM apps WHERE id = ?`).run(id);
    },

    close() {
      db.close();
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run:
```bash
bun test tests/integration/store.test.ts
```
Expected: PASS — all 7 cases green.

- [ ] **Step 5: Commit**

```bash
git add src/registry/store.ts tests/integration/store.test.ts
git commit -m "feat: add SQLite-backed app and agent registry"
```

---

## Task 5: Bearer token utilities

Token generation, constant-time comparison, factory for Hono bearer middleware.

**Files:**
- Create: `src/auth.ts`
- Create: `tests/unit/auth.test.ts`

- [ ] **Step 1: Write the failing test**

Write `tests/unit/auth.test.ts`:
```typescript
import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { generateToken, constantTimeEqual, bearerAuth } from "../../src/auth.ts";

describe("generateToken", () => {
  it("returns base64url-encoded 32-byte token", () => {
    const t = generateToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it("returns distinct values each call", () => {
    expect(generateToken()).not.toBe(generateToken());
  });
});

describe("constantTimeEqual", () => {
  it("returns true for equal strings", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
  });
  it("returns false for differing strings of equal length", () => {
    expect(constantTimeEqual("abc", "abd")).toBe(false);
  });
  it("returns false for differing lengths", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
});

describe("bearerAuth middleware", () => {
  it("passes through with valid bearer", async () => {
    const app = new Hono();
    app.use("*", bearerAuth({ tokens: ["secret"] }));
    app.get("/", (c) => c.text("ok"));
    const res = await app.request("/", {
      headers: { Authorization: "Bearer secret" },
    });
    expect(res.status).toBe(200);
  });

  it("returns 401 with OpenAI-shape error on missing header", async () => {
    const app = new Hono();
    app.use("*", bearerAuth({ tokens: ["secret"] }));
    app.get("/", (c) => c.text("ok"));
    const res = await app.request("/");
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("returns 401 on wrong token", async () => {
    const app = new Hono();
    app.use("*", bearerAuth({ tokens: ["secret"] }));
    app.get("/", (c) => c.text("ok"));
    const res = await app.request("/", {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(401);
  });

  it("accepts dynamic token resolver", async () => {
    const app = new Hono();
    app.use("*", bearerAuth({ resolve: (c) => Promise.resolve(["dyn-token"]) }));
    app.get("/", (c) => c.text("ok"));
    const res = await app.request("/", {
      headers: { Authorization: "Bearer dyn-token" },
    });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
bun test tests/unit/auth.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `src/auth.ts`**

Write `src/auth.ts`:
```typescript
import type { Context, MiddlewareHandler } from "hono";
import { randomBytes, timingSafeEqual } from "node:crypto";

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return timingSafeEqual(bufA, bufB);
}

function unauthorized(c: Context, message = "Missing or invalid bearer token") {
  return c.json(
    {
      error: {
        type: "invalid_request_error",
        message,
        code: "unauthorized",
      },
    },
    401,
  );
}

export type BearerAuthOpts = {
  tokens?: string[];
  resolve?: (c: Context) => Promise<string[]> | string[];
};

export function bearerAuth(opts: BearerAuthOpts): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header("Authorization");
    if (!header?.startsWith("Bearer ")) return unauthorized(c);
    const presented = header.slice(7).trim();
    const valid = opts.tokens || (await opts.resolve!(c));
    for (const candidate of valid) {
      if (constantTimeEqual(presented, candidate)) {
        return next();
      }
    }
    return unauthorized(c);
  };
}
```

- [ ] **Step 4: Run tests**

Run:
```bash
bun test tests/unit/auth.test.ts
```
Expected: PASS — all 8 cases green.

- [ ] **Step 5: Commit**

```bash
git add src/auth.ts tests/unit/auth.test.ts
git commit -m "feat: add bearer token utilities and Hono middleware"
```

---

## Task 6: Manifest fetcher

Fetches `/agents-manifest` from a registered app and validates it.

**Files:**
- Create: `src/registry/manifest.ts`
- Create: `tests/integration/manifest.test.ts`

- [ ] **Step 1: Write the failing test**

Write `tests/integration/manifest.test.ts`:
```typescript
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { fetchManifest, ManifestFetchError } from "../../src/registry/manifest.ts";

function spinUpMockApp(handler: (c: any) => Response | Promise<Response>) {
  const app = new Hono();
  app.get("/agents-manifest", (c) => handler(c));
  return Bun.serve({ port: 0, fetch: app.fetch });
}

describe("fetchManifest", () => {
  it("fetches and parses a valid manifest", async () => {
    const server = spinUpMockApp((c) => {
      const auth = c.req.header("Authorization");
      if (auth !== "Bearer expected-token") {
        return new Response("unauth", { status: 401 });
      }
      return Response.json({
        manifest_version: "1",
        app: { id: "weather-app", name: "Weather", description: "d" },
        agents: [
          {
            id: "weather-bot",
            name: "Bot",
            description: "d",
            system_prompt: "p",
            tools: [],
            skills: [],
          },
        ],
      });
    });
    try {
      const manifest = await fetchManifest({
        baseUrl: `http://localhost:${server.port}`,
        appToken: "expected-token",
      });
      expect(manifest.app.id).toBe("weather-app");
      expect(manifest.agents[0].id).toBe("weather-bot");
    } finally {
      server.stop();
    }
  });

  it("throws ManifestFetchError on non-2xx", async () => {
    const server = spinUpMockApp(() => new Response("server fail", { status: 500 }));
    try {
      await expect(
        fetchManifest({ baseUrl: `http://localhost:${server.port}`, appToken: "t" }),
      ).rejects.toThrow(ManifestFetchError);
    } finally {
      server.stop();
    }
  });

  it("throws ManifestFetchError on invalid manifest", async () => {
    const server = spinUpMockApp(() => Response.json({ manifest_version: "999" }));
    try {
      await expect(
        fetchManifest({ baseUrl: `http://localhost:${server.port}`, appToken: "t" }),
      ).rejects.toThrow(ManifestFetchError);
    } finally {
      server.stop();
    }
  });

  it("throws ManifestFetchError on connection failure", async () => {
    await expect(
      fetchManifest({ baseUrl: "http://localhost:1", appToken: "t" }),
    ).rejects.toThrow(ManifestFetchError);
  });

  it("respects a custom timeout", async () => {
    const server = spinUpMockApp(async () => {
      await Bun.sleep(200);
      return Response.json({});
    });
    try {
      await expect(
        fetchManifest({
          baseUrl: `http://localhost:${server.port}`,
          appToken: "t",
          timeoutMs: 50,
        }),
      ).rejects.toThrow(ManifestFetchError);
    } finally {
      server.stop();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
bun test tests/integration/manifest.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `src/registry/manifest.ts`**

Write `src/registry/manifest.ts`:
```typescript
import { ManifestSchema, type Manifest } from "./schema.ts";

export class ManifestFetchError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ManifestFetchError";
  }
}

export async function fetchManifest(opts: {
  baseUrl: string;
  appToken: string;
  timeoutMs?: number;
}): Promise<Manifest> {
  const url = new URL("/agents-manifest", opts.baseUrl).toString();
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10000);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${opts.appToken}`, Accept: "application/json" },
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new ManifestFetchError(`network error fetching ${url}`, err);
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) {
    throw new ManifestFetchError(`HTTP ${res.status} from ${url}`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new ManifestFetchError(`invalid JSON from ${url}`, err);
  }
  const parsed = ManifestSchema.safeParse(body);
  if (!parsed.success) {
    throw new ManifestFetchError(
      `manifest validation failed: ${parsed.error.message}`,
      parsed.error,
    );
  }
  return parsed.data;
}
```

- [ ] **Step 4: Run tests**

Run:
```bash
bun test tests/integration/manifest.test.ts
```
Expected: PASS — all 5 cases green.

- [ ] **Step 5: Commit**

```bash
git add src/registry/manifest.ts tests/integration/manifest.test.ts
git commit -m "feat: add manifest fetcher with timeout and validation"
```

---

## Task 7: Skill materializer

Writes agent skills to a per-agent tempdir (`<tmpDir>/agents/<agent_id>/.claude/skills/<name>/SKILL.md`) so the Claude Agent SDK can discover them via its native skills mechanism.

**Files:**
- Create: `src/agent/skills.ts`
- Create: `tests/unit/skills.test.ts`

- [ ] **Step 1: Write the failing test**

Write `tests/unit/skills.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeSkills } from "../../src/agent/skills.ts";

describe("materializeSkills", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "iri-skills-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates cwd at <root>/agents/<id> with no skills", async () => {
    const cwd = await materializeSkills({
      tmpDir: root,
      agentId: "weather-bot",
      skills: [],
    });
    expect(cwd).toBe(join(root, "agents", "weather-bot"));
    expect(await Bun.file(join(cwd, ".claude")).exists()).toBe(false);
  });

  it("writes inline skill to .claude/skills/<name>/SKILL.md", async () => {
    const cwd = await materializeSkills({
      tmpDir: root,
      agentId: "weather-bot",
      skills: [
        {
          name: "weather-jargon",
          content: "---\nname: weather-jargon\ndescription: x\n---\n\n# body",
        },
      ],
    });
    const path = join(cwd, ".claude", "skills", "weather-jargon", "SKILL.md");
    const body = await readFile(path, "utf8");
    expect(body).toContain("name: weather-jargon");
    expect(body).toContain("# body");
  });

  it("fetches url-based skill", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response("---\nname: remote\ndescription: x\n---\n\nremote body"),
    });
    try {
      const cwd = await materializeSkills({
        tmpDir: root,
        agentId: "remote-bot",
        skills: [{ name: "remote", url: `http://localhost:${server.port}/skill.md` }],
      });
      const body = await readFile(
        join(cwd, ".claude", "skills", "remote", "SKILL.md"),
        "utf8",
      );
      expect(body).toContain("remote body");
    } finally {
      server.stop();
    }
  });

  it("removes stale skill directories on re-materialize", async () => {
    const cwd = await materializeSkills({
      tmpDir: root,
      agentId: "bot",
      skills: [{ name: "a", content: "---\nname: a\ndescription: x\n---\n\nA" }],
    });
    expect(await Bun.file(join(cwd, ".claude/skills/a/SKILL.md")).exists()).toBe(true);

    await materializeSkills({
      tmpDir: root,
      agentId: "bot",
      skills: [{ name: "b", content: "---\nname: b\ndescription: x\n---\n\nB" }],
    });
    expect(await Bun.file(join(cwd, ".claude/skills/a/SKILL.md")).exists()).toBe(false);
    expect(await Bun.file(join(cwd, ".claude/skills/b/SKILL.md")).exists()).toBe(true);
  });

  it("throws on fetch failure", async () => {
    await expect(
      materializeSkills({
        tmpDir: root,
        agentId: "bot",
        skills: [{ name: "x", url: "http://localhost:1/skill.md" }],
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
bun test tests/unit/skills.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `src/agent/skills.ts`**

Write `src/agent/skills.ts`:
```typescript
import { mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Skill } from "../registry/schema.ts";

export async function materializeSkills(opts: {
  tmpDir: string;
  agentId: string;
  skills: Skill[];
}): Promise<string> {
  const cwd = join(opts.tmpDir, "agents", opts.agentId);
  const skillsRoot = join(cwd, ".claude", "skills");

  // Wipe any existing skills directory so removed skills don't linger.
  await rm(skillsRoot, { recursive: true, force: true });

  if (opts.skills.length === 0) {
    await mkdir(cwd, { recursive: true });
    return cwd;
  }

  await mkdir(skillsRoot, { recursive: true });

  for (const skill of opts.skills) {
    const dir = join(skillsRoot, skill.name);
    await mkdir(dir, { recursive: true });
    let content: string;
    if (skill.content !== undefined) {
      content = skill.content;
    } else if (skill.url) {
      const res = await fetch(skill.url);
      if (!res.ok) {
        throw new Error(`failed to fetch skill ${skill.name}: HTTP ${res.status}`);
      }
      content = await res.text();
    } else {
      throw new Error(`skill ${skill.name} has neither content nor url`);
    }
    await writeFile(join(dir, "SKILL.md"), content, "utf8");
  }

  return cwd;
}
```

- [ ] **Step 4: Run tests**

Run:
```bash
bun test tests/unit/skills.test.ts
```
Expected: PASS — all 5 cases green.

- [ ] **Step 5: Commit**

```bash
git add src/agent/skills.ts tests/unit/skills.test.ts
git commit -m "feat: materialize app skills to per-agent tempdir"
```

---

## Task 8: SSE translator

Pure function: translates Claude Agent SDK stream events to OpenAI-compatible chat-completion SSE chunks. Heart of OpenAI compatibility.

**Files:**
- Create: `src/agent/openai-sse.ts`
- Create: `tests/unit/openai-sse.test.ts`

- [ ] **Step 1: Write the failing test**

Write `tests/unit/openai-sse.test.ts`:
```typescript
import { describe, it, expect } from "bun:test";
import {
  translateSdkEvent,
  type OpenAIChunk,
  type SdkEvent,
} from "../../src/agent/openai-sse.ts";

const CTX = {
  id: "chatcmpl-01H",
  created: 1717200000,
  model: "claude-sonnet-4-6",
  showToolCalls: false,
};

function chunkContent(chunks: OpenAIChunk[]): string {
  return chunks
    .flatMap((c) => c.choices.map((ch) => ch.delta.content || ""))
    .join("");
}

describe("translateSdkEvent", () => {
  it("emits role-only delta as the first chunk on stream_start", () => {
    const out = translateSdkEvent({ type: "stream_start" } as SdkEvent, CTX);
    expect(out).toHaveLength(1);
    expect(out[0].choices[0].delta).toEqual({ role: "assistant", content: "" });
    expect(out[0].id).toBe(CTX.id);
    expect(out[0].model).toBe(CTX.model);
    expect(out[0].object).toBe("chat.completion.chunk");
  });

  it("emits content delta on text_chunk", () => {
    const out = translateSdkEvent(
      { type: "text_chunk", text: "Hello" } as SdkEvent,
      CTX,
    );
    expect(out).toHaveLength(1);
    expect(out[0].choices[0].delta).toEqual({ content: "Hello" });
  });

  it("aggregated text matches the source events", () => {
    const events: SdkEvent[] = [
      { type: "stream_start" },
      { type: "text_chunk", text: "Hello " },
      { type: "text_chunk", text: "world." },
    ];
    const chunks = events.flatMap((e) => translateSdkEvent(e, CTX));
    expect(chunkContent(chunks)).toBe("Hello world.");
  });

  it("omits tool calls by default", () => {
    const out = translateSdkEvent(
      { type: "tool_use", name: "get_forecast", input: { location: "NYC" } } as SdkEvent,
      CTX,
    );
    expect(out).toEqual([]);
  });

  it("emits tool_calls delta when showToolCalls=true", () => {
    const out = translateSdkEvent(
      { type: "tool_use", id: "tu_1", name: "get_forecast", input: { location: "NYC" } } as SdkEvent,
      { ...CTX, showToolCalls: true },
    );
    expect(out).toHaveLength(1);
    expect(out[0].choices[0].delta.tool_calls?.[0]).toEqual({
      index: 0,
      id: "tu_1",
      type: "function",
      function: { name: "get_forecast", arguments: '{"location":"NYC"}' },
    });
  });

  it("emits finish chunk on done", () => {
    const out = translateSdkEvent({ type: "done", reason: "stop" } as SdkEvent, CTX);
    expect(out).toHaveLength(1);
    expect(out[0].choices[0].finish_reason).toBe("stop");
    expect(out[0].choices[0].delta).toEqual({});
  });

  it("maps max_turns reason to length", () => {
    const out = translateSdkEvent(
      { type: "done", reason: "max_turns" } as SdkEvent,
      CTX,
    );
    expect(out[0].choices[0].finish_reason).toBe("length");
  });

  it("emits error system delta on error event", () => {
    const out = translateSdkEvent(
      { type: "error", message: "boom" } as SdkEvent,
      CTX,
    );
    expect(out).toHaveLength(1);
    expect(out[0].choices[0].delta.content).toContain("boom");
  });
});

describe("DONE sentinel formatting", () => {
  it("the gateway encodes done as 'data: [DONE]'", async () => {
    const { formatSseChunk, DONE_SENTINEL } = await import(
      "../../src/agent/openai-sse.ts"
    );
    expect(formatSseChunk({ id: "x", object: "chat.completion.chunk", created: 0, model: "m", choices: [] })).toContain("data: ");
    expect(DONE_SENTINEL).toBe("data: [DONE]\n\n");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
bun test tests/unit/openai-sse.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `src/agent/openai-sse.ts`**

Write `src/agent/openai-sse.ts`:
```typescript
// SDK event shapes are normalized inside the gateway (see runner.ts) before
// being handed to translateSdkEvent. The runner adapts the actual Claude
// Agent SDK message stream into these neutral shapes.
export type SdkEvent =
  | { type: "stream_start" }
  | { type: "text_chunk"; text: string }
  | { type: "tool_use"; id?: string; name: string; input: unknown }
  | { type: "tool_result"; id?: string; result: unknown; is_error?: boolean }
  | { type: "done"; reason: "stop" | "max_turns" | "tool_failure" | "error" }
  | { type: "error"; message: string };

export type OpenAIDelta = {
  role?: "assistant";
  content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

export type OpenAIChoice = {
  index: number;
  delta: OpenAIDelta;
  finish_reason?: "stop" | "length" | "tool_calls" | "content_filter" | null;
};

export type OpenAIChunk = {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: OpenAIChoice[];
};

export type TranslateContext = {
  id: string;
  created: number;
  model: string;
  showToolCalls: boolean;
};

let nextToolIndex = 0; // module-local; runner resets per-request via newToolIndex

function chunk(ctx: TranslateContext, choice: Partial<OpenAIChoice>): OpenAIChunk {
  return {
    id: ctx.id,
    object: "chat.completion.chunk",
    created: ctx.created,
    model: ctx.model,
    choices: [{ index: 0, delta: {}, ...choice } as OpenAIChoice],
  };
}

export function translateSdkEvent(ev: SdkEvent, ctx: TranslateContext): OpenAIChunk[] {
  switch (ev.type) {
    case "stream_start":
      nextToolIndex = 0;
      return [chunk(ctx, { delta: { role: "assistant", content: "" } })];
    case "text_chunk":
      if (!ev.text) return [];
      return [chunk(ctx, { delta: { content: ev.text } })];
    case "tool_use":
      if (!ctx.showToolCalls) return [];
      return [
        chunk(ctx, {
          delta: {
            tool_calls: [
              {
                index: nextToolIndex++,
                id: ev.id,
                type: "function",
                function: { name: ev.name, arguments: JSON.stringify(ev.input) },
              },
            ],
          },
        }),
      ];
    case "tool_result":
      // Tool results are fed back to the LLM; clients see only the model's
      // next text turn. Nothing emitted to OpenAI stream.
      return [];
    case "done":
      return [
        chunk(ctx, {
          delta: {},
          finish_reason:
            ev.reason === "max_turns" ? "length" : ev.reason === "stop" ? "stop" : "stop",
        }),
      ];
    case "error":
      return [chunk(ctx, { delta: { content: `\n\n[gateway error: ${ev.message}]` } })];
  }
}

export function formatSseChunk(c: OpenAIChunk): string {
  return `data: ${JSON.stringify(c)}\n\n`;
}

export const DONE_SENTINEL = "data: [DONE]\n\n";
```

- [ ] **Step 4: Run tests**

Run:
```bash
bun test tests/unit/openai-sse.test.ts
```
Expected: PASS — all 9 cases green.

- [ ] **Step 5: Commit**

```bash
git add src/agent/openai-sse.ts tests/unit/openai-sse.test.ts
git commit -m "feat: translate SDK events into OpenAI SSE chunks"
```

---

## Task 9: MCP tool server (api_call)

Builds an in-process MCP tool server that exposes each `api_call` tool from a manifest to the Claude Agent SDK. When invoked, the tool POSTs to the owning app's endpoint with the LLM's parameters, with one retry on 5xx/timeout.

**IMPORTANT — verify SDK MCP API:** the in-process MCP server helpers in `@anthropic-ai/claude-agent-sdk` are named `createSdkMcpServer` and `tool`. Before implementing, confirm the current export names by running:

```bash
bunx tsc --noEmit -p . 2>&1 | head -20
node -e "console.log(Object.keys(require('@anthropic-ai/claude-agent-sdk')))"
```

If the names differ, update the imports in this task and Task 10 accordingly.

**Files:**
- Create: `src/agent/tools.ts`
- Create: `tests/integration/tools.test.ts`

- [ ] **Step 1: Write the failing test**

Write `tests/integration/tools.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { invokeApiCallTool } from "../../src/agent/tools.ts";
import type { Tool } from "../../src/registry/schema.ts";

function spinUp(handler: (c: any) => Response | Promise<Response>) {
  const app = new Hono();
  app.all("*", (c) => handler(c));
  return Bun.serve({ port: 0, fetch: app.fetch });
}

const SAMPLE_TOOL: Tool = {
  type: "api_call",
  name: "get_forecast",
  description: "d",
  parameters: { type: "object", properties: {}, required: [] },
  endpoint: { method: "POST", path: "/api/forecast" },
};

describe("invokeApiCallTool", () => {
  it("posts JSON body to <base_url><path> with bearer", async () => {
    let captured: { auth?: string; body?: any } = {};
    const server = spinUp(async (c) => {
      captured.auth = c.req.header("Authorization");
      captured.body = await c.req.json();
      return Response.json({ ok: true, echoed: captured.body });
    });
    try {
      const res = await invokeApiCallTool({
        tool: SAMPLE_TOOL,
        baseUrl: `http://localhost:${server.port}`,
        appToken: "tok",
        input: { location: "NYC", days: 3 },
        defaultTimeoutMs: 1000,
      });
      expect(captured.auth).toBe("Bearer tok");
      expect(captured.body).toEqual({ location: "NYC", days: 3 });
      expect(res).toEqual({ ok: true, echoed: { location: "NYC", days: 3 } });
    } finally {
      server.stop();
    }
  });

  it("returns 4xx body as error object (no retry)", async () => {
    let calls = 0;
    const server = spinUp(() => {
      calls++;
      return Response.json({ message: "bad" }, { status: 400 });
    });
    try {
      const res = await invokeApiCallTool({
        tool: SAMPLE_TOOL,
        baseUrl: `http://localhost:${server.port}`,
        appToken: "t",
        input: {},
        defaultTimeoutMs: 1000,
      });
      expect(calls).toBe(1);
      expect(res).toEqual({ error: { status: 400, body: { message: "bad" } } });
    } finally {
      server.stop();
    }
  });

  it("retries once on 5xx and succeeds on retry", async () => {
    let calls = 0;
    const server = spinUp(() => {
      calls++;
      if (calls === 1) return new Response("err", { status: 500 });
      return Response.json({ ok: true });
    });
    try {
      const res = await invokeApiCallTool({
        tool: SAMPLE_TOOL,
        baseUrl: `http://localhost:${server.port}`,
        appToken: "t",
        input: {},
        defaultTimeoutMs: 1000,
      });
      expect(calls).toBe(2);
      expect(res).toEqual({ ok: true });
    } finally {
      server.stop();
    }
  });

  it("returns error after second 5xx", async () => {
    let calls = 0;
    const server = spinUp(() => {
      calls++;
      return new Response(JSON.stringify({ x: 1 }), { status: 502 });
    });
    try {
      const res = await invokeApiCallTool({
        tool: SAMPLE_TOOL,
        baseUrl: `http://localhost:${server.port}`,
        appToken: "t",
        input: {},
        defaultTimeoutMs: 1000,
      });
      expect(calls).toBe(2);
      expect((res as any).error.status).toBe(502);
    } finally {
      server.stop();
    }
  });

  it("times out per tool.timeout_ms and retries once", async () => {
    let calls = 0;
    const server = spinUp(async () => {
      calls++;
      await Bun.sleep(200);
      return Response.json({});
    });
    try {
      const res = await invokeApiCallTool({
        tool: { ...SAMPLE_TOOL, timeout_ms: 50 },
        baseUrl: `http://localhost:${server.port}`,
        appToken: "t",
        input: {},
        defaultTimeoutMs: 100,
      });
      expect(calls).toBe(2);
      expect((res as any).error.kind).toBe("timeout");
    } finally {
      server.stop();
    }
  });

  it("uses GET when method=GET (no body)", async () => {
    let captured: { method?: string; url?: string } = {};
    const server = spinUp((c) => {
      captured.method = c.req.method;
      captured.url = c.req.url;
      return Response.json({ ok: true });
    });
    try {
      await invokeApiCallTool({
        tool: { ...SAMPLE_TOOL, endpoint: { method: "GET", path: "/api/ping" } },
        baseUrl: `http://localhost:${server.port}`,
        appToken: "t",
        input: { ignored: true },
        defaultTimeoutMs: 1000,
      });
      expect(captured.method).toBe("GET");
      expect(captured.url).toContain("/api/ping");
    } finally {
      server.stop();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
bun test tests/integration/tools.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `src/agent/tools.ts`**

Write `src/agent/tools.ts`:
```typescript
import type { Tool } from "../registry/schema.ts";

export type ToolInvocationResult = unknown; // either app's JSON or { error: { ... } }

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}

async function callOnce(opts: {
  url: string;
  method: string;
  body: unknown;
  appToken: string;
  timeoutMs: number;
}): Promise<{ ok: true; data: unknown } | { ok: false; kind: "http" | "timeout" | "network"; status?: number; body?: unknown; message?: string }> {
  try {
    const init: RequestInit = {
      method: opts.method,
      headers: {
        Authorization: `Bearer ${opts.appToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    };
    if (opts.method !== "GET" && opts.method !== "HEAD") {
      (init as any).body = JSON.stringify(opts.body);
    }
    const res = await fetchWithTimeout(opts.url, init, opts.timeoutMs);
    let body: unknown = null;
    const text = await res.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (res.ok) return { ok: true, data: body };
    return { ok: false, kind: "http", status: res.status, body };
  } catch (err) {
    if ((err as any).name === "AbortError") {
      return { ok: false, kind: "timeout", message: `request exceeded ${opts.timeoutMs}ms` };
    }
    return { ok: false, kind: "network", message: (err as Error).message };
  }
}

export async function invokeApiCallTool(opts: {
  tool: Tool;
  baseUrl: string;
  appToken: string;
  input: Record<string, unknown>;
  defaultTimeoutMs: number;
}): Promise<ToolInvocationResult> {
  if (opts.tool.type !== "api_call") {
    throw new Error(`unsupported tool type: ${(opts.tool as any).type}`);
  }
  const timeoutMs = opts.tool.timeout_ms ?? opts.defaultTimeoutMs;
  const url = new URL(opts.tool.endpoint.path, opts.baseUrl).toString();
  const method = opts.tool.endpoint.method;

  let attempt = await callOnce({ url, method, body: opts.input, appToken: opts.appToken, timeoutMs });
  // Retry once on 5xx, timeout, or network error.
  const retriable =
    !attempt.ok &&
    (attempt.kind === "timeout" ||
      attempt.kind === "network" ||
      (attempt.kind === "http" && (attempt.status ?? 0) >= 500));
  if (retriable) {
    await Bun.sleep(500);
    attempt = await callOnce({ url, method, body: opts.input, appToken: opts.appToken, timeoutMs });
  }
  if (attempt.ok) return attempt.data;
  if (attempt.kind === "timeout" || attempt.kind === "network") {
    return { error: { kind: attempt.kind, message: attempt.message } };
  }
  return { error: { status: attempt.status, body: attempt.body } };
}
```

- [ ] **Step 4: Run tests**

Run:
```bash
bun test tests/integration/tools.test.ts
```
Expected: PASS — all 6 cases green.

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools.ts tests/integration/tools.test.ts
git commit -m "feat: add api_call tool invoker with single retry"
```

---

## Task 10: Agent runner

The orchestration layer that ties everything together. Resolves the agent, materializes skills, builds the in-process MCP tool server registering each `api_call` tool as a callable, invokes the Claude Agent SDK's `query()`, normalizes its stream into the neutral `SdkEvent` shape consumed by the SSE translator.

**IMPORTANT — verify SDK API:** before implementing, confirm the current `@anthropic-ai/claude-agent-sdk` TypeScript export names and shapes. Quick check:
```bash
node -e "console.log(Object.keys(require('@anthropic-ai/claude-agent-sdk')))"
```
The implementation below assumes: `query({ prompt, options })` returns an async iterable of messages where each message has `type` ("system" | "assistant" | "user" | "result") and (for assistant) a `message` payload with `content` blocks of types `text` and `tool_use`. Also `createSdkMcpServer({ name, version, tools })` and `tool(name, description, paramSchema, handler)` are the in-process MCP helpers. If the actual API differs, adjust the normalization (`adaptSdkStream`) only — the rest of the gateway depends only on the neutral `SdkEvent` shape.

**Files:**
- Create: `src/agent/runner.ts`
- Create: `tests/integration/runner.test.ts`
- Create: `tests/helpers/fake-anthropic.ts`

- [ ] **Step 1: Write the fake Anthropic server helper**

Write `tests/helpers/fake-anthropic.ts`:
```typescript
import { Hono } from "hono";

export type Scripted = {
  /** Each entry is one turn the fake will return. */
  turns: Array<
    | { kind: "text"; text: string }
    | { kind: "tool_use"; id: string; name: string; input: unknown; text?: string }
  >;
};

/** Spin up a tiny HTTP server that mimics Anthropic's /v1/messages SSE. */
export function spinUpFakeAnthropic(script: Scripted) {
  const app = new Hono();
  app.post("/v1/messages", async (c) => {
    return new Response(streamFor(script), {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });
  });
  return Bun.serve({ port: 0, fetch: app.fetch });
}

function sse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function streamFor(script: Scripted): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      controller.enqueue(
        encoder.encode(
          sse("message_start", { type: "message_start", message: { id: "m1", role: "assistant", content: [], model: "claude-sonnet-4-6" } }),
        ),
      );
      let blockIndex = 0;
      for (const turn of script.turns) {
        if (turn.kind === "text") {
          controller.enqueue(encoder.encode(sse("content_block_start", { type: "content_block_start", index: blockIndex, content_block: { type: "text", text: "" } })));
          controller.enqueue(encoder.encode(sse("content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text: turn.text } })));
          controller.enqueue(encoder.encode(sse("content_block_stop", { type: "content_block_stop", index: blockIndex })));
          blockIndex++;
        } else if (turn.kind === "tool_use") {
          if (turn.text) {
            controller.enqueue(encoder.encode(sse("content_block_start", { type: "content_block_start", index: blockIndex, content_block: { type: "text", text: "" } })));
            controller.enqueue(encoder.encode(sse("content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text: turn.text } })));
            controller.enqueue(encoder.encode(sse("content_block_stop", { type: "content_block_stop", index: blockIndex })));
            blockIndex++;
          }
          controller.enqueue(encoder.encode(sse("content_block_start", { type: "content_block_start", index: blockIndex, content_block: { type: "tool_use", id: turn.id, name: turn.name, input: {} } })));
          controller.enqueue(encoder.encode(sse("content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "input_json_delta", partial_json: JSON.stringify(turn.input) } })));
          controller.enqueue(encoder.encode(sse("content_block_stop", { type: "content_block_stop", index: blockIndex })));
          blockIndex++;
        }
      }
      controller.enqueue(encoder.encode(sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } })));
      controller.enqueue(encoder.encode(sse("message_stop", { type: "message_stop" })));
      controller.close();
    },
  });
}
```

- [ ] **Step 2: Write the failing test**

Write `tests/integration/runner.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { createStore, type Store } from "../../src/registry/store.ts";
import { runAgentStream } from "../../src/agent/runner.ts";
import { spinUpFakeAnthropic } from "../helpers/fake-anthropic.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;
let store: Store;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "iri-runner-"));
  store = createStore({ dbPath: ":memory:" });
});
afterEach(async () => {
  store.close();
  await rm(tmp, { recursive: true, force: true });
});

const baseConfig = () => ({
  defaultModel: "claude-sonnet-4-6",
  tmpDir: tmp,
  maxAgentTurns: 5,
  toolCallTimeoutMs: 1000,
  anthropicApiKey: "ak-test",
});

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let s = "";
  for await (const x of stream) s += x;
  return s;
}

describe("runAgentStream — generic agent (no iri_agent)", () => {
  it("streams a text-only response as OpenAI SSE", async () => {
    const fake = spinUpFakeAnthropic({ turns: [{ kind: "text", text: "Hello world" }] });
    try {
      const stream = runAgentStream({
        config: { ...baseConfig(), anthropicBaseUrl: `http://localhost:${fake.port}` },
        store,
        request: {
          requestId: "01H",
          agentId: null,
          model: "claude-sonnet-4-6",
          messages: [{ role: "user", content: "hi" }],
          showToolCalls: false,
        },
      });
      const out = await collect(stream);
      expect(out).toContain("Hello world");
      expect(out).toContain("data: [DONE]");
    } finally {
      fake.stop();
    }
  });
});

describe("runAgentStream — app-owned agent with tool call", () => {
  it("invokes app endpoint and streams final answer", async () => {
    const fake = spinUpFakeAnthropic({
      turns: [
        { kind: "tool_use", id: "tu_1", name: "get_forecast", input: { location: "NYC" } },
        { kind: "text", text: "Sunny, 72°F." },
      ],
    });
    const appApp = new Hono();
    appApp.post("/api/forecast", async (c) => {
      const body = await c.req.json();
      expect(body).toEqual({ location: "NYC" });
      return Response.json({ temp_f: 72, condition: "sunny" });
    });
    const appServer = Bun.serve({ port: 0, fetch: appApp.fetch });
    try {
      store.upsertApp({
        id: "weather-app",
        base_url: `http://localhost:${appServer.port}`,
        app_token: "app-tok",
        manifest: {
          manifest_version: "1",
          app: { id: "weather-app", name: "w", description: "w" },
          agents: [
            {
              id: "weather-bot",
              name: "Bot",
              description: "d",
              system_prompt: "you are a bot",
              tools: [
                {
                  type: "api_call",
                  name: "get_forecast",
                  description: "get forecast",
                  parameters: { type: "object", properties: { location: { type: "string" } }, required: ["location"] },
                  endpoint: { method: "POST", path: "/api/forecast" },
                },
              ],
              skills: [],
            },
          ],
        },
      });
      const stream = runAgentStream({
        config: { ...baseConfig(), anthropicBaseUrl: `http://localhost:${fake.port}` },
        store,
        request: {
          requestId: "01H",
          agentId: "weather-bot",
          model: null,
          messages: [{ role: "user", content: "weather in NYC?" }],
          showToolCalls: false,
        },
      });
      const out = await collect(stream);
      expect(out).toContain("Sunny, 72°F.");
      expect(out).toContain("data: [DONE]");
    } finally {
      appServer.stop();
      fake.stop();
    }
  });

  it("throws 404-shaped error for unknown agent", async () => {
    const fake = spinUpFakeAnthropic({ turns: [{ kind: "text", text: "unused" }] });
    try {
      const stream = runAgentStream({
        config: { ...baseConfig(), anthropicBaseUrl: `http://localhost:${fake.port}` },
        store,
        request: {
          requestId: "01H",
          agentId: "missing-bot",
          model: null,
          messages: [{ role: "user", content: "x" }],
          showToolCalls: false,
        },
      });
      await expect(collect(stream)).rejects.toMatchObject({ httpStatus: 404 });
    } finally {
      fake.stop();
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run:
```bash
bun test tests/integration/runner.test.ts
```
Expected: FAIL — `runAgentStream` doesn't exist.

- [ ] **Step 4: Implement `src/agent/runner.ts`**

Write `src/agent/runner.ts`:
```typescript
import { ulid } from "ulid";
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Config } from "../config.ts";
import type { Store, AgentLookup } from "../registry/store.ts";
import type { Tool, Agent } from "../registry/schema.ts";
import { materializeSkills } from "./skills.ts";
import { invokeApiCallTool } from "./tools.ts";
import {
  translateSdkEvent,
  formatSseChunk,
  DONE_SENTINEL,
  type SdkEvent,
  type TranslateContext,
} from "./openai-sse.ts";

const GENERIC_SYSTEM_PROMPT =
  "You are a helpful general-purpose assistant.";

export class GatewayError extends Error {
  constructor(
    public httpStatus: number,
    public type: string,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

export type ChatRequest = {
  requestId: string;
  agentId: string | null;
  model: string | null;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  showToolCalls: boolean;
};

export type RunnerOpts = {
  config: Pick<
    Config,
    | "defaultModel"
    | "tmpDir"
    | "maxAgentTurns"
    | "toolCallTimeoutMs"
    | "anthropicApiKey"
    | "anthropicBaseUrl"
  >;
  store: Store;
  request: ChatRequest;
};

export function runAgentStream(opts: RunnerOpts): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]() {
      return generate(opts);
    },
  };
}

async function* generate(opts: RunnerOpts): AsyncGenerator<string> {
  const { config, store, request } = opts;
  // Resolve agent (or generic).
  let lookup: AgentLookup | null = null;
  if (request.agentId) {
    lookup = store.lookupAgent(request.agentId);
    if (!lookup) {
      const known = store
        .listApps()
        .flatMap((a) => a.manifest?.agents.map((ag) => ag.id) ?? []);
      throw new GatewayError(
        404,
        "invalid_request_error",
        `unknown agent: ${request.agentId}. Known: ${known.join(", ") || "(none)"}`,
        "unknown_agent",
      );
    }
  }

  const agent: Agent | null = lookup?.agent ?? null;
  const systemPrompt = agent?.system_prompt || GENERIC_SYSTEM_PROMPT;
  const model = request.model || agent?.default_model || config.defaultModel;
  const chatId = `chatcmpl-${ulid()}`;
  const created = Math.floor(Date.now() / 1000);
  const tCtx: TranslateContext = {
    id: chatId,
    created,
    model,
    showToolCalls: request.showToolCalls,
  };

  // Materialize skills (no-op if agent has none).
  const cwd = await materializeSkills({
    tmpDir: config.tmpDir,
    agentId: agent?.id ?? "_generic",
    skills: agent?.skills ?? [],
  });

  // Build in-process MCP tool server for the agent's api_call tools.
  const mcpTools = (agent?.tools ?? []).map((t) =>
    tool(
      t.name,
      t.description,
      // We pass the JSON Schema through verbatim by adapting it to a Zod
      // record — the SDK uses the JSON Schema when advertising the tool to
      // the model, but accepts arbitrary record inputs at invocation time.
      z.record(z.unknown()),
      async (args: Record<string, unknown>) => {
        const result = await invokeApiCallTool({
          tool: t as Tool,
          baseUrl: lookup!.app.base_url,
          appToken: lookup!.app.app_token,
          input: args,
          defaultTimeoutMs: config.toolCallTimeoutMs,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      },
    ),
  );

  const mcpServer =
    mcpTools.length > 0
      ? createSdkMcpServer({ name: "iriguchi-app-tools", version: "1.0.0", tools: mcpTools })
      : undefined;

  // Set Anthropic env for the SDK call (the SDK reads from process.env).
  const prevKey = process.env.ANTHROPIC_API_KEY;
  const prevBase = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_API_KEY = config.anthropicApiKey;
  if (config.anthropicBaseUrl) {
    process.env.ANTHROPIC_BASE_URL = config.anthropicBaseUrl;
  }

  try {
    // Open the stream with a role-only chunk.
    for (const c of translateSdkEvent({ type: "stream_start" }, tCtx)) {
      yield formatSseChunk(c);
    }

    // The TS SDK takes a single prompt string plus history via the input format.
    // We collapse the OpenAI messages into a single user-facing prompt for v1.
    const prompt = buildPrompt(request.messages);

    const sdkOptions: Record<string, unknown> = {
      model,
      systemPrompt,
      cwd,
      maxTurns: config.maxAgentTurns,
      settingSources: ["project"],
      skills: "all",
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
  } finally {
    if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
    if (prevBase !== undefined) process.env.ANTHROPIC_BASE_URL = prevBase;
    else delete process.env.ANTHROPIC_BASE_URL;
  }
}

function buildPrompt(messages: ChatRequest["messages"]): string {
  // Minimal: concatenate non-system messages, last user message last.
  // System messages are merged into systemPrompt by the caller in a future
  // enhancement; for v1 we forward only the latest user turn plus history
  // as a single string.
  return messages
    .filter((m) => m.role !== "system")
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n\n");
}

/**
 * Translate the Claude Agent SDK's native message stream into our neutral
 * SdkEvent shape. Defensive against minor shape variation across SDK
 * versions — if the SDK changes, only adjust this function.
 */
async function* adaptSdkStream(stream: AsyncIterable<any>): AsyncGenerator<SdkEvent> {
  for await (const msg of stream) {
    if (msg?.type === "assistant" && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text) {
          yield { type: "text_chunk", text: block.text };
        } else if (block.type === "tool_use") {
          yield {
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.input,
          };
        }
      }
    } else if (msg?.type === "user" && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === "tool_result") {
          yield { type: "tool_result", id: block.tool_use_id, result: block.content };
        }
      }
    } else if (msg?.type === "result") {
      // Final result is signaled separately in the runner; nothing here.
    }
  }
}
```

- [ ] **Step 5: Run tests**

Run:
```bash
bun test tests/integration/runner.test.ts
```
Expected: PASS — all 3 cases green. If a test fails due to SDK API drift, inspect the actual SDK exports and adjust `adaptSdkStream` and the `sdkOptions` shape only.

- [ ] **Step 6: Commit**

```bash
git add src/agent/runner.ts tests/integration/runner.test.ts tests/helpers/fake-anthropic.ts
git commit -m "feat: agent runner orchestrates SDK, tools, skills, SSE translation"
```

---

## Task 11: Hono server skeleton with health route

Establish the server file and verify Hono + Bun.serve work end-to-end.

**Files:**
- Create: `src/server.ts`
- Create: `tests/integration/health.test.ts`

- [ ] **Step 1: Write the failing test**

Write `tests/integration/health.test.ts`:
```typescript
import { describe, it, expect } from "bun:test";
import { buildApp } from "../../src/server.ts";

describe("server", () => {
  it("GET /healthz returns 200 ok", async () => {
    const app = buildApp({
      config: {
        port: 0,
        defaultModel: "x",
        maxAgentTurns: 5,
        toolCallTimeoutMs: 1000,
        manifestCacheTtlMs: 1000,
        requestTimeoutMs: 1000,
        dbPath: ":memory:",
        tmpDir: ".iri-tmp",
        anthropicApiKey: "ak",
        anthropicBaseUrl: undefined,
        apiKey: "k",
        registrationSecret: "s",
      },
    });
    const res = await app.fetch(new Request("http://x/healthz"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("ok");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
bun test tests/integration/health.test.ts
```
Expected: FAIL — `buildApp` doesn't exist.

- [ ] **Step 3: Implement skeleton `src/server.ts`**

Write `src/server.ts`:
```typescript
import { Hono } from "hono";
import type { Config } from "./config.ts";
import { loadConfig } from "./config.ts";
import { createLogger, type Logger } from "./logger.ts";
import { createStore, type Store } from "./registry/store.ts";

export type AppDeps = {
  config: Config;
  store?: Store;
  logger?: Logger;
};

export function buildApp(deps: AppDeps) {
  const logger = deps.logger ?? createLogger();
  const store = deps.store ?? createStore({ dbPath: deps.config.dbPath });
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  // Routes mounted in later tasks.
  // app.route("/v1", openaiRoutes({ config: deps.config, store, logger }));
  // app.route("/apps", registrationRoutes({ config: deps.config, store, logger }));

  return app;
}

if (import.meta.main) {
  const config = loadConfig();
  const logger = createLogger();
  const app = buildApp({ config, logger });
  Bun.serve({ port: config.port, fetch: app.fetch });
  logger.info("server.start", { port: config.port });
}
```

- [ ] **Step 4: Run tests**

Run:
```bash
bun test tests/integration/health.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/integration/health.test.ts
git commit -m "feat: bootstrap Hono server with health route"
```

---

## Task 12: `GET /v1/models` route

Lists allowed models so OpenAI clients can populate model dropdowns.

**Files:**
- Create: `src/routes/openai.ts`
- Modify: `src/server.ts`
- Create: `tests/integration/models.test.ts`

- [ ] **Step 1: Write the failing test**

Write `tests/integration/models.test.ts`:
```typescript
import { describe, it, expect } from "bun:test";
import { buildApp } from "../../src/server.ts";

const cfg = {
  port: 0,
  defaultModel: "claude-sonnet-4-6",
  maxAgentTurns: 5,
  toolCallTimeoutMs: 1000,
  manifestCacheTtlMs: 1000,
  requestTimeoutMs: 1000,
  dbPath: ":memory:",
  tmpDir: ".iri-tmp",
  anthropicApiKey: "ak",
  anthropicBaseUrl: undefined,
  apiKey: "client-key",
  registrationSecret: "reg",
};

describe("GET /v1/models", () => {
  it("requires bearer auth", async () => {
    const app = buildApp({ config: cfg });
    const res = await app.fetch(new Request("http://x/v1/models"));
    expect(res.status).toBe(401);
  });

  it("returns OpenAI-shape model list", async () => {
    const app = buildApp({ config: cfg });
    const res = await app.fetch(
      new Request("http://x/v1/models", {
        headers: { Authorization: "Bearer client-key" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.object).toBe("list");
    const ids = body.data.map((m: any) => m.id);
    expect(ids).toContain("claude-sonnet-4-6");
    body.data.forEach((m: any) => {
      expect(m.object).toBe("model");
      expect(typeof m.created).toBe("number");
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
bun test tests/integration/models.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `src/routes/openai.ts`**

Write `src/routes/openai.ts`:
```typescript
import { Hono } from "hono";
import { bearerAuth } from "../auth.ts";
import type { Config } from "../config.ts";

export function openaiRoutes(deps: { config: Config }) {
  const app = new Hono();
  app.use("*", bearerAuth({ tokens: [deps.config.apiKey] }));

  app.get("/models", (c) => {
    const created = Math.floor(Date.now() / 1000);
    const allowed = [deps.config.defaultModel, "claude-opus-4-8", "claude-haiku-4-5"];
    return c.json({
      object: "list",
      data: allowed.map((id) => ({
        id,
        object: "model",
        created,
        owned_by: "iriguchi",
      })),
    });
  });

  return app;
}
```

- [ ] **Step 4: Mount the route in `src/server.ts`**

Edit `src/server.ts` to add the import and mount. Replace the placeholder comment block with:
```typescript
import { openaiRoutes } from "./routes/openai.ts";
// ... existing imports ...

export function buildApp(deps: AppDeps) {
  const logger = deps.logger ?? createLogger();
  const store = deps.store ?? createStore({ dbPath: deps.config.dbPath });
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  app.route("/v1", openaiRoutes({ config: deps.config }));

  return app;
}
```

(Leave the `if (import.meta.main)` block at the bottom unchanged.)

- [ ] **Step 5: Run tests**

Run:
```bash
bun test tests/integration/models.test.ts
```
Expected: PASS — both cases green.

- [ ] **Step 6: Commit**

```bash
git add src/routes/openai.ts src/server.ts tests/integration/models.test.ts
git commit -m "feat: add /v1/models OpenAI-compatible endpoint"
```

---

## Task 13: `POST /v1/chat/completions` route

Streams agent responses back to clients as OpenAI SSE. Wires up the runner.

**Files:**
- Modify: `src/routes/openai.ts`
- Create: `tests/integration/chat.test.ts`

- [ ] **Step 1: Write the failing test**

Write `tests/integration/chat.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { buildApp } from "../../src/server.ts";
import { createStore, type Store } from "../../src/registry/store.ts";
import { spinUpFakeAnthropic } from "../helpers/fake-anthropic.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;
let store: Store;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "iri-chat-"));
  store = createStore({ dbPath: ":memory:" });
});
afterEach(async () => {
  store.close();
  await rm(tmp, { recursive: true, force: true });
});

const baseCfg = () => ({
  port: 0,
  defaultModel: "claude-sonnet-4-6",
  maxAgentTurns: 5,
  toolCallTimeoutMs: 1000,
  manifestCacheTtlMs: 1000,
  requestTimeoutMs: 5000,
  dbPath: ":memory:",
  tmpDir: tmp,
  anthropicApiKey: "ak",
  anthropicBaseUrl: undefined as string | undefined,
  apiKey: "client-key",
  registrationSecret: "reg",
});

async function readAllSse(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
  }
  return out;
}

describe("POST /v1/chat/completions", () => {
  it("rejects unauthorized", async () => {
    const app = buildApp({ config: baseCfg(), store });
    const res = await app.fetch(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("streams generic-agent SSE", async () => {
    const fake = spinUpFakeAnthropic({ turns: [{ kind: "text", text: "Hi there" }] });
    try {
      const cfg = { ...baseCfg(), anthropicBaseUrl: `http://localhost:${fake.port}` };
      const app = buildApp({ config: cfg, store });
      const res = await app.fetch(
        new Request("http://x/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer client-key" },
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            messages: [{ role: "user", content: "hi" }],
            stream: true,
          }),
        }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const body = await readAllSse(res);
      expect(body).toContain("Hi there");
      expect(body).toContain("data: [DONE]");
    } finally {
      fake.stop();
    }
  });

  it("returns 404 for unknown iri_agent", async () => {
    const fake = spinUpFakeAnthropic({ turns: [{ kind: "text", text: "unused" }] });
    try {
      const cfg = { ...baseCfg(), anthropicBaseUrl: `http://localhost:${fake.port}` };
      const app = buildApp({ config: cfg, store });
      const res = await app.fetch(
        new Request("http://x/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer client-key" },
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            messages: [{ role: "user", content: "hi" }],
            iri_agent: "missing",
            stream: true,
          }),
        }),
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as any;
      expect(body.error.code).toBe("unknown_agent");
    } finally {
      fake.stop();
    }
  });

  it("includes X-Request-Id header", async () => {
    const fake = spinUpFakeAnthropic({ turns: [{ kind: "text", text: "x" }] });
    try {
      const cfg = { ...baseCfg(), anthropicBaseUrl: `http://localhost:${fake.port}` };
      const app = buildApp({ config: cfg, store });
      const res = await app.fetch(
        new Request("http://x/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer client-key" },
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            messages: [{ role: "user", content: "hi" }],
            stream: true,
          }),
        }),
      );
      expect(res.headers.get("X-Request-Id")).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      await readAllSse(res);
    } finally {
      fake.stop();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
bun test tests/integration/chat.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Update `src/routes/openai.ts` with the chat route**

Replace `src/routes/openai.ts` with:
```typescript
import { Hono } from "hono";
import { ulid } from "ulid";
import { bearerAuth } from "../auth.ts";
import type { Config } from "../config.ts";
import type { Store } from "../registry/store.ts";
import type { Logger } from "../logger.ts";
import { runAgentStream, GatewayError } from "../agent/runner.ts";

export function openaiRoutes(deps: { config: Config; store: Store; logger: Logger }) {
  const app = new Hono();
  app.use("*", bearerAuth({ tokens: [deps.config.apiKey] }));

  app.get("/models", (c) => {
    const created = Math.floor(Date.now() / 1000);
    const allowed = [deps.config.defaultModel, "claude-opus-4-8", "claude-haiku-4-5"];
    return c.json({
      object: "list",
      data: allowed.map((id) => ({ id, object: "model", created, owned_by: "iriguchi" })),
    });
  });

  app.post("/chat/completions", async (c) => {
    const requestId = ulid();
    const logger = deps.logger.with({ request_id: requestId });
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { error: { type: "invalid_request_error", message: "invalid JSON body" } },
        400,
      );
    }
    if (!Array.isArray(body.messages)) {
      return c.json(
        { error: { type: "invalid_request_error", message: "messages must be an array" } },
        400,
      );
    }
    const showToolCalls = c.req.query("iri_show_tool_calls") === "true";
    logger.info("request.start", {
      method: "POST",
      path: "/v1/chat/completions",
      iri_agent: body.iri_agent ?? null,
      model: body.model ?? null,
    });

    // Stream the response.
    try {
      const stream = runAgentStream({
        config: deps.config,
        store: deps.store,
        request: {
          requestId,
          agentId: typeof body.iri_agent === "string" ? body.iri_agent : null,
          model: typeof body.model === "string" ? body.model : null,
          messages: body.messages,
          showToolCalls,
        },
      });

      // Eagerly probe the first chunk so we can convert GatewayError into a
      // proper HTTP status before we've sent any bytes.
      const iter = stream[Symbol.asyncIterator]();
      let first: IteratorResult<string>;
      try {
        first = await iter.next();
      } catch (err) {
        if (err instanceof GatewayError) {
          return c.json(
            { error: { type: err.type, message: err.message, code: err.code } },
            err.httpStatus as any,
            { "X-Request-Id": requestId },
          );
        }
        throw err;
      }

      c.header("X-Request-Id", requestId);
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      c.header("Connection", "keep-alive");
      const start = Date.now();

      return c.body(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            const encoder = new TextEncoder();
            try {
              if (!first.done) controller.enqueue(encoder.encode(first.value));
              while (true) {
                const { done, value } = await iter.next();
                if (done) break;
                controller.enqueue(encoder.encode(value));
              }
              logger.info("request.complete", { duration_ms: Date.now() - start });
            } catch (err) {
              logger.error("request.stream_error", {
                err: (err as Error).message,
                duration_ms: Date.now() - start,
              });
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ error: (err as Error).message })}\n\n`),
              );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            } finally {
              controller.close();
            }
          },
        }),
      );
    } catch (err) {
      if (err instanceof GatewayError) {
        return c.json(
          { error: { type: err.type, message: err.message, code: err.code } },
          err.httpStatus as any,
          { "X-Request-Id": requestId },
        );
      }
      logger.error("request.unhandled_error", { err: (err as Error).message });
      return c.json(
        { error: { type: "internal_error", message: (err as Error).message } },
        500,
        { "X-Request-Id": requestId },
      );
    }
  });

  return app;
}
```

- [ ] **Step 4: Update `src/server.ts` to pass store + logger to openai routes**

Edit `src/server.ts`. Replace the `app.route("/v1", ...)` line with:
```typescript
  app.route("/v1", openaiRoutes({ config: deps.config, store, logger }));
```

- [ ] **Step 5: Run tests**

Run:
```bash
bun test tests/integration/chat.test.ts
```
Expected: PASS — all 4 cases green.

- [ ] **Step 6: Commit**

```bash
git add src/routes/openai.ts src/server.ts tests/integration/chat.test.ts
git commit -m "feat: add /v1/chat/completions streaming endpoint"
```

---

## Task 14: Registration routes

`POST /apps/register`, `POST /apps/:id/refresh-manifest`, `DELETE /apps/:id`.

**Files:**
- Create: `src/routes/registration.ts`
- Modify: `src/server.ts`
- Create: `tests/integration/registration.test.ts`

- [ ] **Step 1: Write the failing test**

Write `tests/integration/registration.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { buildApp } from "../../src/server.ts";
import { createStore, type Store } from "../../src/registry/store.ts";

let store: Store;
let appServer: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let manifestResponse: Record<string, unknown>;

beforeEach(() => {
  store = createStore({ dbPath: ":memory:" });
  manifestResponse = {
    manifest_version: "1",
    app: { id: "weather-app", name: "Weather", description: "d" },
    agents: [
      {
        id: "weather-bot",
        name: "Bot",
        description: "d",
        system_prompt: "p",
        tools: [],
        skills: [],
      },
    ],
  };
  const appApp = new Hono();
  appApp.get("/agents-manifest", (c) => {
    if (!c.req.header("Authorization")?.startsWith("Bearer ")) {
      return c.json({}, 401);
    }
    return c.json(manifestResponse);
  });
  appServer = Bun.serve({ port: 0, fetch: appApp.fetch });
  baseUrl = `http://localhost:${appServer.port}`;
});
afterEach(() => {
  appServer.stop();
  store.close();
});

const cfg = () => ({
  port: 0,
  defaultModel: "claude-sonnet-4-6",
  maxAgentTurns: 5,
  toolCallTimeoutMs: 1000,
  manifestCacheTtlMs: 1000,
  requestTimeoutMs: 1000,
  dbPath: ":memory:",
  tmpDir: ".iri-tmp",
  anthropicApiKey: "ak",
  anthropicBaseUrl: undefined,
  apiKey: "client-key",
  registrationSecret: "reg-secret",
});

describe("POST /apps/register", () => {
  it("rejects missing registration secret", async () => {
    const app = buildApp({ config: cfg(), store });
    const res = await app.fetch(
      new Request("http://x/apps/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "weather-app", base_url: baseUrl }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("registers app, fetches manifest, returns app_token + accepted_agents", async () => {
    const app = buildApp({ config: cfg(), store });
    const res = await app.fetch(
      new Request("http://x/apps/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer reg-secret",
        },
        body: JSON.stringify({ id: "weather-app", base_url: baseUrl }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.app_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.accepted_agents).toEqual(["weather-bot"]);
    expect(store.getApp("weather-app")?.app_token).toBe(body.app_token);
  });

  it("502 when manifest fetch fails", async () => {
    const app = buildApp({ config: cfg(), store });
    const res = await app.fetch(
      new Request("http://x/apps/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer reg-secret",
        },
        body: JSON.stringify({ id: "x", base_url: "http://localhost:1" }),
      }),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("app_unavailable");
    expect(store.getApp("x")).toBeNull();
  });
});

describe("POST /apps/:id/refresh-manifest", () => {
  it("refreshes manifest with correct app_token", async () => {
    const app = buildApp({ config: cfg(), store });
    const reg = await app.fetch(
      new Request("http://x/apps/register", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer reg-secret" },
        body: JSON.stringify({ id: "weather-app", base_url: baseUrl }),
      }),
    );
    const { app_token } = (await reg.json()) as any;

    // Change the manifest the mock app returns.
    (manifestResponse as any).agents = [
      ...(manifestResponse as any).agents,
      {
        id: "weather-bot-2",
        name: "B2",
        description: "d",
        system_prompt: "p",
        tools: [],
        skills: [],
      },
    ];

    const refresh = await app.fetch(
      new Request("http://x/apps/weather-app/refresh-manifest", {
        method: "POST",
        headers: { Authorization: `Bearer ${app_token}` },
      }),
    );
    expect(refresh.status).toBe(200);
    expect(store.lookupAgent("weather-bot-2")?.app.id).toBe("weather-app");
  });

  it("401 with wrong token", async () => {
    const app = buildApp({ config: cfg(), store });
    await app.fetch(
      new Request("http://x/apps/register", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer reg-secret" },
        body: JSON.stringify({ id: "weather-app", base_url: baseUrl }),
      }),
    );
    const refresh = await app.fetch(
      new Request("http://x/apps/weather-app/refresh-manifest", {
        method: "POST",
        headers: { Authorization: "Bearer wrong" },
      }),
    );
    expect(refresh.status).toBe(401);
  });
});

describe("DELETE /apps/:id", () => {
  it("deregisters and cascades agents", async () => {
    const app = buildApp({ config: cfg(), store });
    const reg = await app.fetch(
      new Request("http://x/apps/register", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer reg-secret" },
        body: JSON.stringify({ id: "weather-app", base_url: baseUrl }),
      }),
    );
    const { app_token } = (await reg.json()) as any;
    const del = await app.fetch(
      new Request("http://x/apps/weather-app", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${app_token}` },
      }),
    );
    expect(del.status).toBe(204);
    expect(store.getApp("weather-app")).toBeNull();
    expect(store.lookupAgent("weather-bot")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
bun test tests/integration/registration.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `src/routes/registration.ts`**

Write `src/routes/registration.ts`:
```typescript
import { Hono } from "hono";
import { bearerAuth, generateToken } from "../auth.ts";
import { fetchManifest, ManifestFetchError } from "../registry/manifest.ts";
import type { Config } from "../config.ts";
import type { Store } from "../registry/store.ts";
import type { Logger } from "../logger.ts";

export function registrationRoutes(deps: { config: Config; store: Store; logger: Logger }) {
  const app = new Hono();

  // App-token bearer middleware factory bound to a path param.
  const appTokenAuth = bearerAuth({
    resolve: (c) => {
      const id = c.req.param("id");
      const stored = id ? deps.store.getApp(id) : null;
      return stored ? [stored.app_token] : [];
    },
  });

  app.post(
    "/register",
    bearerAuth({ tokens: [deps.config.registrationSecret] }),
    async (c) => {
      let body: any;
      try {
        body = await c.req.json();
      } catch {
        return c.json(
          { error: { type: "invalid_request_error", message: "invalid JSON body" } },
          400,
        );
      }
      if (typeof body.id !== "string" || typeof body.base_url !== "string") {
        return c.json(
          {
            error: {
              type: "invalid_request_error",
              message: "id and base_url are required strings",
            },
          },
          400,
        );
      }
      const appToken = generateToken();
      try {
        const manifest = await fetchManifest({ baseUrl: body.base_url, appToken });
        if (manifest.app.id !== body.id) {
          return c.json(
            {
              error: {
                type: "invalid_request_error",
                message: `manifest app.id (${manifest.app.id}) does not match registration id (${body.id})`,
              },
            },
            400,
          );
        }
        deps.store.upsertApp({
          id: body.id,
          base_url: body.base_url,
          app_token: appToken,
          manifest,
        });
        deps.logger.info("app.register", {
          app_id: body.id,
          base_url: body.base_url,
          agents: manifest.agents.map((a) => a.id),
        });
        return c.json(
          { app_token: appToken, accepted_agents: manifest.agents.map((a) => a.id) },
          201,
        );
      } catch (err) {
        if (err instanceof ManifestFetchError) {
          deps.logger.warn("app.register_failed", {
            app_id: body.id,
            err: err.message,
          });
          return c.json(
            {
              error: {
                type: "app_unavailable",
                message: err.message,
                code: "app_unavailable",
              },
            },
            502,
          );
        }
        throw err;
      }
    },
  );

  app.post("/:id/refresh-manifest", appTokenAuth, async (c) => {
    const id = c.req.param("id");
    const stored = deps.store.getApp(id);
    if (!stored) {
      return c.json(
        { error: { type: "invalid_request_error", message: "app not found" } },
        404,
      );
    }
    try {
      const manifest = await fetchManifest({
        baseUrl: stored.base_url,
        appToken: stored.app_token,
      });
      deps.store.upsertApp({
        id,
        base_url: stored.base_url,
        app_token: stored.app_token,
        manifest,
      });
      deps.logger.info("manifest.fetch", { app_id: id, agents: manifest.agents.length });
      return c.json({ accepted_agents: manifest.agents.map((a) => a.id) });
    } catch (err) {
      if (err instanceof ManifestFetchError) {
        return c.json(
          { error: { type: "app_unavailable", message: err.message, code: "app_unavailable" } },
          502,
        );
      }
      throw err;
    }
  });

  app.delete("/:id", appTokenAuth, (c) => {
    const id = c.req.param("id");
    deps.store.deleteApp(id);
    deps.logger.info("app.deregister", { app_id: id });
    return c.body(null, 204);
  });

  return app;
}
```

- [ ] **Step 4: Mount the route in `src/server.ts`**

Edit `src/server.ts`. Add the import:
```typescript
import { registrationRoutes } from "./routes/registration.ts";
```
Add the mount inside `buildApp` after the `/v1` mount:
```typescript
  app.route("/apps", registrationRoutes({ config: deps.config, store, logger }));
```

- [ ] **Step 5: Run tests**

Run:
```bash
bun test tests/integration/registration.test.ts
```
Expected: PASS — all 6 cases green.

- [ ] **Step 6: Commit**

```bash
git add src/routes/registration.ts src/server.ts tests/integration/registration.test.ts
git commit -m "feat: add app registration, refresh, deregister routes"
```

---

## Task 15: Background manifest refresher

A periodic timer that re-fetches manifests older than `manifestCacheTtlMs`. Stale-on-error.

**Files:**
- Create: `src/registry/refresher.ts`
- Create: `tests/integration/refresher.test.ts`

- [ ] **Step 1: Write the failing test**

Write `tests/integration/refresher.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { createStore, type Store } from "../../src/registry/store.ts";
import { startBackgroundRefresh } from "../../src/registry/refresher.ts";
import { createLogger } from "../../src/logger.ts";

let store: Store;
let appServer: ReturnType<typeof Bun.serve>;
let manifest: any;

beforeEach(() => {
  store = createStore({ dbPath: ":memory:" });
  manifest = {
    manifest_version: "1",
    app: { id: "w", name: "w", description: "w" },
    agents: [
      { id: "bot-1", name: "B", description: "d", system_prompt: "p", tools: [], skills: [] },
    ],
  };
  const a = new Hono();
  a.get("/agents-manifest", (c) => c.json(manifest));
  appServer = Bun.serve({ port: 0, fetch: a.fetch });
  store.upsertApp({
    id: "w",
    base_url: `http://localhost:${appServer.port}`,
    app_token: "t",
    manifest,
  });
});
afterEach(() => {
  appServer.stop();
  store.close();
});

describe("startBackgroundRefresh", () => {
  it("refreshes stale manifests on its tick", async () => {
    const logger = createLogger({ sink: () => {} });
    // Set ttl=0 so the existing manifest is immediately stale.
    const handle = startBackgroundRefresh({
      store,
      logger,
      ttlMs: 0,
      intervalMs: 30,
    });
    try {
      manifest.agents.push({
        id: "bot-2",
        name: "B2",
        description: "d",
        system_prompt: "p",
        tools: [],
        skills: [],
      });
      // Wait for at least one tick.
      await Bun.sleep(120);
      expect(store.lookupAgent("bot-2")?.app.id).toBe("w");
    } finally {
      handle.stop();
    }
  });

  it("keeps last-good on fetch failure (stale-on-error)", async () => {
    // Kill the upstream so refresh fails.
    appServer.stop();
    const logger = createLogger({ sink: () => {} });
    const handle = startBackgroundRefresh({
      store,
      logger,
      ttlMs: 0,
      intervalMs: 30,
    });
    try {
      await Bun.sleep(120);
      expect(store.lookupAgent("bot-1")?.app.id).toBe("w");
    } finally {
      handle.stop();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
bun test tests/integration/refresher.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement `src/registry/refresher.ts`**

Write `src/registry/refresher.ts`:
```typescript
import { fetchManifest, ManifestFetchError } from "./manifest.ts";
import type { Store } from "./store.ts";
import type { Logger } from "../logger.ts";

export type RefresherHandle = { stop(): void };

export function startBackgroundRefresh(opts: {
  store: Store;
  logger: Logger;
  ttlMs: number;
  intervalMs: number;
}): RefresherHandle {
  const tick = async () => {
    const now = Date.now();
    for (const app of opts.store.listApps()) {
      const fetchedAt = app.manifest_fetched_at ?? 0;
      if (now - fetchedAt < opts.ttlMs) continue;
      try {
        const manifest = await fetchManifest({
          baseUrl: app.base_url,
          appToken: app.app_token,
        });
        opts.store.upsertApp({
          id: app.id,
          base_url: app.base_url,
          app_token: app.app_token,
          manifest,
        });
        opts.logger.info("manifest.fetch", { app_id: app.id, stale: true });
      } catch (err) {
        opts.logger.warn("manifest.refresh_failed", {
          app_id: app.id,
          err: err instanceof ManifestFetchError ? err.message : String(err),
        });
      }
    }
  };
  const t = setInterval(() => {
    void tick();
  }, opts.intervalMs);
  return {
    stop() {
      clearInterval(t);
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run:
```bash
bun test tests/integration/refresher.test.ts
```
Expected: PASS — both cases green.

- [ ] **Step 5: Commit**

```bash
git add src/registry/refresher.ts tests/integration/refresher.test.ts
git commit -m "feat: background manifest refresher with stale-on-error"
```

---

## Task 16: Wire everything in server.ts and add startup smoke test

Mount routes, start the refresher when running as a main module, end-to-end smoke test.

**Files:**
- Modify: `src/server.ts`
- Create: `tests/integration/server-smoke.test.ts`

- [ ] **Step 1: Write the smoke test**

Write `tests/integration/server-smoke.test.ts`:
```typescript
import { describe, it, expect } from "bun:test";
import { buildApp } from "../../src/server.ts";

const cfg = {
  port: 0,
  defaultModel: "claude-sonnet-4-6",
  maxAgentTurns: 5,
  toolCallTimeoutMs: 1000,
  manifestCacheTtlMs: 1000,
  requestTimeoutMs: 1000,
  dbPath: ":memory:",
  tmpDir: ".iri-tmp",
  anthropicApiKey: "ak",
  anthropicBaseUrl: undefined,
  apiKey: "client-key",
  registrationSecret: "reg",
};

describe("server smoke", () => {
  it("has /healthz", async () => {
    const app = buildApp({ config: cfg });
    expect((await app.fetch(new Request("http://x/healthz"))).status).toBe(200);
  });

  it("has /v1/models (auth required)", async () => {
    const app = buildApp({ config: cfg });
    expect((await app.fetch(new Request("http://x/v1/models"))).status).toBe(401);
  });

  it("has /apps/register (auth required)", async () => {
    const app = buildApp({ config: cfg });
    const res = await app.fetch(
      new Request("http://x/apps/register", { method: "POST", body: "{}" }),
    );
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run smoke test**

Run:
```bash
bun test tests/integration/server-smoke.test.ts
```
Expected: PASS (these routes are already wired from prior tasks).

- [ ] **Step 3: Update `src/server.ts` to start the refresher when run as main**

Replace `src/server.ts` (preserving existing exports) with:
```typescript
import { Hono } from "hono";
import type { Config } from "./config.ts";
import { loadConfig } from "./config.ts";
import { createLogger, type Logger } from "./logger.ts";
import { createStore, type Store } from "./registry/store.ts";
import { openaiRoutes } from "./routes/openai.ts";
import { registrationRoutes } from "./routes/registration.ts";
import { startBackgroundRefresh } from "./registry/refresher.ts";

export type AppDeps = {
  config: Config;
  store?: Store;
  logger?: Logger;
};

export function buildApp(deps: AppDeps) {
  const logger = deps.logger ?? createLogger();
  const store = deps.store ?? createStore({ dbPath: deps.config.dbPath });
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.route("/v1", openaiRoutes({ config: deps.config, store, logger }));
  app.route("/apps", registrationRoutes({ config: deps.config, store, logger }));

  return app;
}

if (import.meta.main) {
  const config = loadConfig();
  const logger = createLogger();
  const store = createStore({ dbPath: config.dbPath });
  const app = buildApp({ config, store, logger });
  Bun.serve({ port: config.port, fetch: app.fetch });
  startBackgroundRefresh({
    store,
    logger,
    ttlMs: config.manifestCacheTtlMs,
    intervalMs: 30000,
  });
  logger.info("server.start", { port: config.port });
}
```

- [ ] **Step 4: Typecheck**

Run:
```bash
bun run typecheck
```
Expected: no errors.

- [ ] **Step 5: Run full test suite**

Run:
```bash
bun test
```
Expected: all tests green.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts tests/integration/server-smoke.test.ts
git commit -m "feat: wire all routes + start background refresher in main"
```

---

## Task 17: Demo weather-app

A separate Bun/Hono server on port 4001 that registers with the gateway, exposes a manifest, hosts a tool endpoint, and serves a chat UI.

**Files:**
- Create: `examples/weather-app/package.json`
- Create: `examples/weather-app/tsconfig.json`
- Create: `examples/weather-app/src/server.ts`
- Create: `examples/weather-app/src/manifest.ts`
- Create: `examples/weather-app/public/index.html`
- Create: `examples/weather-app/skills/weather-jargon.md`
- Create: `examples/weather-app/README.md`

- [ ] **Step 1: Create the example app's package.json**

Write `examples/weather-app/package.json`:
```json
{
  "name": "iriguchi-example-weather",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun --hot src/server.ts",
    "start": "bun src/server.ts"
  },
  "dependencies": {
    "hono": "^4.0.0"
  }
}
```

- [ ] **Step 2: Create the example app's tsconfig**

Write `examples/weather-app/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.json",
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Install dependencies**

Run:
```bash
cd /Users/randal/dev/iriguchi/examples/weather-app && bun install
```
Then return to repo root:
```bash
cd /Users/randal/dev/iriguchi
```

- [ ] **Step 4: Create the skill content**

Write `examples/weather-app/skills/weather-jargon.md`:
```markdown
---
name: weather-jargon
description: Explanations of common weather terminology used by the forecast tool. Reference this when explaining results.
---

# Weather Jargon

- **Heat index** — perceived temperature when humidity is factored in.
- **Wind chill** — perceived temperature when wind is factored in.
- **Pressure (hPa)** — atmospheric pressure; below 1000 hPa often precedes storms.
- **Dew point** — the temperature at which dew forms; above 18°C feels muggy.

When answering, prefer plain language over jargon, but use these terms when the user asks "what does X mean?".
```

- [ ] **Step 5: Create the manifest module**

Write `examples/weather-app/src/manifest.ts`:
```typescript
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function buildManifest() {
  const skillBody = await readFile(
    join(__dirname, "..", "skills", "weather-jargon.md"),
    "utf8",
  );
  return {
    manifest_version: "1",
    app: {
      id: "weather-app",
      name: "Weather App",
      description: "Demo app exposing a weather forecast agent.",
    },
    agents: [
      {
        id: "weather-bot",
        name: "Weather Bot",
        description: "Answers questions about current and forecast weather.",
        system_prompt:
          "You are a helpful weather assistant. When a user asks about weather, use the get_forecast tool with the location they mention. Then answer in plain language using the data returned. If you reference jargon, briefly explain it.",
        tools: [
          {
            type: "api_call" as const,
            name: "get_forecast",
            description: "Get a fake but plausible weather forecast for a location.",
            parameters: {
              type: "object",
              properties: {
                location: { type: "string", description: "City name" },
                days: { type: "integer", minimum: 1, maximum: 7, default: 3 },
              },
              required: ["location"],
            },
            endpoint: { method: "POST" as const, path: "/api/forecast" },
          },
        ],
        skills: [
          { name: "weather-jargon", content: skillBody },
        ],
      },
    ],
  };
}
```

- [ ] **Step 6: Create the server**

Write `examples/weather-app/src/server.ts`:
```typescript
import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifest } from "./manifest.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.WEATHER_PORT ?? 4001);
const SELF_BASE_URL = process.env.WEATHER_BASE_URL ?? `http://localhost:${PORT}`;
const GATEWAY_URL = process.env.IRI_GATEWAY_URL ?? "http://localhost:4000";
const REG_SECRET = process.env.IRI_REGISTRATION_SECRET ?? "";

let appToken: string | null = null;

const app = new Hono();

app.get("/agents-manifest", async (c) => {
  if (!c.req.header("Authorization")?.startsWith("Bearer ")) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return c.json(await buildManifest());
});

app.post("/api/forecast", async (c) => {
  if (!c.req.header("Authorization")?.startsWith("Bearer ")) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const { location, days = 3 } = (await c.req.json()) as {
    location?: string;
    days?: number;
  };
  if (!location) {
    return c.json({ error: "location required" }, 400);
  }
  // Deterministic fake forecast.
  const seed = [...location].reduce((s, c) => s + c.charCodeAt(0), 0);
  const baseTemp = 50 + (seed % 30);
  const conditions = ["sunny", "cloudy", "rainy", "windy", "snowy"];
  const days_out = Array.from({ length: days }).map((_, i) => ({
    day: i + 1,
    high_f: baseTemp + (i * 3) % 10,
    low_f: baseTemp - 10 + (i * 2) % 8,
    condition: conditions[(seed + i) % conditions.length],
  }));
  return c.json({ location, days_out });
});

app.get("/", async (c) => {
  const html = await readFile(join(__dirname, "..", "public", "index.html"), "utf8");
  return c.html(html);
});

async function register() {
  if (!REG_SECRET) {
    console.warn("[weather-app] IRI_REGISTRATION_SECRET unset, skipping registration");
    return;
  }
  // Retry on cold-start of the gateway.
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(`${GATEWAY_URL}/apps/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${REG_SECRET}` },
        body: JSON.stringify({ id: "weather-app", base_url: SELF_BASE_URL }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`gateway returned ${res.status}: ${text}`);
      }
      const { app_token, accepted_agents } = (await res.json()) as {
        app_token: string;
        accepted_agents: string[];
      };
      appToken = app_token;
      console.log(`[weather-app] registered, agents: ${accepted_agents.join(", ")}`);
      return;
    } catch (err) {
      console.warn(`[weather-app] registration attempt ${attempt} failed: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  console.error("[weather-app] could not register with gateway after 5 attempts");
}

Bun.serve({ port: PORT, fetch: app.fetch });
console.log(`[weather-app] listening on ${SELF_BASE_URL}`);
void register();
```

- [ ] **Step 7: Create the chat UI**

Write `examples/weather-app/public/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Weather Bot — Iriguchi demo</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; }
      #log { border: 1px solid #ccc; padding: 1rem; height: 60vh; overflow-y: auto; white-space: pre-wrap; font-family: ui-monospace, monospace; font-size: 14px; }
      .me { color: #036; }
      .bot { color: #060; }
      form { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
      input[type=text] { flex: 1; padding: 0.5rem; }
      button { padding: 0.5rem 1rem; }
      label { display: block; margin: 0.5rem 0; font-size: 0.85rem; color: #444; }
    </style>
  </head>
  <body>
    <h1>Weather Bot</h1>
    <p>Demo chat backed by Iriguchi + Claude Sonnet via the <code>weather-bot</code> agent.</p>
    <label>Gateway URL <input id="gw" type="text" value="http://localhost:4000" style="width: 18rem" /></label>
    <label>API key <input id="key" type="text" value="" placeholder="IRI_API_KEY" style="width: 18rem" /></label>
    <div id="log"></div>
    <form id="f">
      <input id="msg" type="text" placeholder="What's the weather in NYC?" autocomplete="off" />
      <button type="submit">Send</button>
    </form>
    <script>
      const log = document.getElementById("log");
      const history = [];
      function append(role, text) {
        const div = document.createElement("div");
        div.className = role === "user" ? "me" : "bot";
        div.textContent = `${role}: ${text}`;
        log.appendChild(div);
        log.scrollTop = log.scrollHeight;
      }
      document.getElementById("f").addEventListener("submit", async (e) => {
        e.preventDefault();
        const gw = document.getElementById("gw").value.trim();
        const key = document.getElementById("key").value.trim();
        const text = document.getElementById("msg").value.trim();
        if (!text) return;
        history.push({ role: "user", content: text });
        append("user", text);
        document.getElementById("msg").value = "";
        const res = await fetch(`${gw}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            iri_agent: "weather-bot",
            messages: history,
            stream: true,
          }),
        });
        if (!res.ok) {
          append("error", `${res.status}: ${await res.text()}`);
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let assistantText = "";
        const div = document.createElement("div");
        div.className = "bot";
        div.textContent = "assistant: ";
        log.appendChild(div);
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6);
            if (data === "[DONE]") continue;
            try {
              const obj = JSON.parse(data);
              const delta = obj.choices?.[0]?.delta?.content;
              if (delta) {
                assistantText += delta;
                div.textContent = `assistant: ${assistantText}`;
                log.scrollTop = log.scrollHeight;
              }
            } catch {}
          }
        }
        history.push({ role: "assistant", content: assistantText });
      });
    </script>
  </body>
</html>
```

- [ ] **Step 8: Create a quick README for the example**

Write `examples/weather-app/README.md`:
```markdown
# Weather App — Iriguchi demo

A minimal Bun/Hono app that registers itself with the Iriguchi gateway, exposes one agent (`weather-bot`) with one `api_call` tool (`get_forecast`) and one inline skill (`weather-jargon`), and serves a static chat UI at `/`.

## Run

1. Start the gateway in one terminal:
   ```bash
   IRI_API_KEY=mykey \
   IRI_REGISTRATION_SECRET=regsecret \
   ANTHROPIC_API_KEY=sk-... \
   bun run dev
   ```
2. Start this app in another terminal:
   ```bash
   cd examples/weather-app
   IRI_REGISTRATION_SECRET=regsecret bun run dev
   ```
3. Open <http://localhost:4001>, paste `mykey` into the API key field, and ask "What's the weather in NYC?"
```

- [ ] **Step 9: Commit**

```bash
git add examples/weather-app/
git commit -m "feat: add weather-app demo with manifest, tool, skill, chat UI"
```

---

## Task 18: End-to-end test (gated by IRI_E2E=1)

Spins up the gateway plus the example app, makes one real Anthropic call, asserts a real response.

**Files:**
- Create: `tests/e2e/full-flow.test.ts`

- [ ] **Step 1: Write the e2e test**

Write `tests/e2e/full-flow.test.ts`:
```typescript
import { describe, it, expect } from "bun:test";
import { spawn } from "bun";
import { buildApp } from "../../src/server.ts";
import { createStore } from "../../src/registry/store.ts";
import { createLogger } from "../../src/logger.ts";
import { loadConfig } from "../../src/config.ts";

const E2E = process.env.IRI_E2E === "1";

(E2E ? describe : describe.skip)("e2e: full flow", () => {
  it("registers an app, calls Claude, gets a real response", async () => {
    if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY === "test-anthropic-key") {
      throw new Error("real ANTHROPIC_API_KEY required for e2e");
    }
    const config = loadConfig({
      ...process.env,
      IRI_DB_PATH: ":memory:",
      IRI_TMP_DIR: "./.iri-tmp-e2e",
      IRI_PORT: "0",
    });
    const logger = createLogger({ sink: () => {} });
    const store = createStore({ dbPath: config.dbPath });
    const gw = Bun.serve({ port: 0, fetch: buildApp({ config, store, logger }).fetch });

    // Start the example weather app in a subprocess pointing at the gateway.
    const weatherProc = spawn({
      cmd: ["bun", "examples/weather-app/src/server.ts"],
      env: {
        ...process.env,
        WEATHER_PORT: "0",
        IRI_GATEWAY_URL: `http://localhost:${gw.port}`,
        IRI_REGISTRATION_SECRET: config.registrationSecret,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      // Wait for registration log line.
      const reader = weatherProc.stdout!.getReader();
      const decoder = new TextDecoder();
      const deadline = Date.now() + 15000;
      let buf = "";
      let port = 0;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value);
        const m = buf.match(/listening on http:\/\/localhost:(\d+)/);
        if (m) port = Number(m[1]);
        if (port && buf.includes("registered, agents:")) break;
      }
      expect(port).toBeGreaterThan(0);

      const res = await fetch(`http://localhost:${gw.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          iri_agent: "weather-bot",
          messages: [{ role: "user", content: "What's the weather in San Francisco?" }],
          stream: true,
        }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      // Real responses are non-deterministic, so assert on structure not text.
      expect(text).toContain("data: [DONE]");
      // At least one delta with non-empty content.
      const contents = text
        .split("\n\n")
        .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
        .map((l) => {
          try {
            const obj = JSON.parse(l.slice(6));
            return obj.choices?.[0]?.delta?.content ?? "";
          } catch {
            return "";
          }
        })
        .join("");
      expect(contents.length).toBeGreaterThan(0);
    } finally {
      weatherProc.kill();
      gw.stop();
      store.close();
    }
  });
});
```

- [ ] **Step 2: Confirm it skips without IRI_E2E=1**

Run:
```bash
bun test tests/e2e/full-flow.test.ts
```
Expected: 0 tests run, "skipped" reported, exit 0.

- [ ] **Step 3: (Optional, manual) Run the e2e against real Anthropic**

If you have a real `ANTHROPIC_API_KEY` configured, run:
```bash
IRI_E2E=1 ANTHROPIC_API_KEY=sk-real bun run test:e2e
```
Expected: passes within ~2 minutes. Skip this step if you don't want to spend tokens during plan execution; manual verification is acceptable.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/full-flow.test.ts
git commit -m "test: add e2e full-flow test gated by IRI_E2E=1"
```

---

## Task 19: README

Project-level README so a fresh contributor (or future-you) can run it without re-reading the spec.

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Overwrite `README.md`**

Write `README.md`:
````markdown
# Iriguchi

Iriguchi (Japanese: "entrance / gateway") is an AI gateway: a single OpenAI-compatible chat endpoint that runs Claude Agent SDK-powered agents on behalf of other applications. Apps register themselves with the gateway and expose a `/agents-manifest` endpoint describing their agents, tools, and skills. Other apps don't need to embed agent logic — they just call this gateway.

- **Stack:** Bun, Hono, Zod, `@anthropic-ai/claude-agent-sdk`, `bun:sqlite`.
- **OpenAI compat:** Vanilla `/v1/chat/completions` works with OpenWebUI, OpenCode, and other OpenAI-compatible clients. App-aware mode is opt-in via the `iri_agent` field.
- **Local LLM:** Set `ANTHROPIC_BASE_URL` to point at Ollama (≥ 0.14.0) or LM Studio (≥ 0.4.1), both of which expose the Anthropic `/v1/messages` API natively.

## Quickstart

1. Copy `.env.example` to `.env` and fill in `ANTHROPIC_API_KEY`, `IRI_API_KEY`, `IRI_REGISTRATION_SECRET`.
2. Start the gateway:
   ```bash
   bun install
   bun run dev
   ```
3. (Optional) Start the demo weather app in another terminal:
   ```bash
   cd examples/weather-app
   bun install
   IRI_REGISTRATION_SECRET=$(grep IRI_REGISTRATION_SECRET ../../.env | cut -d= -f2) bun run dev
   ```
4. Open <http://localhost:4001> and ask "What's the weather in NYC?"

## Generic OpenAI client usage

```bash
curl http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer $IRI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

## App-aware usage

```bash
curl http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer $IRI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "iri_agent": "weather-bot",
    "messages": [{"role": "user", "content": "Forecast for Tokyo"}],
    "stream": true
  }'
```

## Tests

```bash
bun test               # unit + integration
bun run typecheck      # tsc --noEmit
IRI_E2E=1 bun run test:e2e   # real Anthropic call (manual, spends tokens)
```

## Layout

See `docs/superpowers/specs/2026-06-01-iriguchi-ai-gateway-design.md` for the full design.

```
src/
├── server.ts               # Hono app, startup
├── routes/openai.ts        # /v1/* — chat + models
├── routes/registration.ts  # /apps/* — register, refresh, delete
├── agent/
│   ├── runner.ts           # Wraps Claude Agent SDK query()
│   ├── tools.ts            # api_call tool → HTTP
│   ├── skills.ts           # Materialize skills to tempdir
│   └── openai-sse.ts       # SDK events → OpenAI SSE chunks
├── registry/
│   ├── store.ts            # SQLite store
│   ├── manifest.ts         # /agents-manifest fetcher
│   ├── refresher.ts        # Background TTL refresh
│   └── schema.ts           # Zod schemas
├── auth.ts                 # Bearer middleware
├── config.ts               # Env loader
└── logger.ts               # Structured JSON logger
```
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add project README with quickstart and layout"
```

---

## Final verification

- [ ] **Step 1: Run the full test suite**

Run:
```bash
bun test
```
Expected: all unit + integration tests green. (E2E is opt-in via `IRI_E2E=1`.)

- [ ] **Step 2: Typecheck**

Run:
```bash
bun run typecheck
```
Expected: no errors.

- [ ] **Step 3: Start the gateway manually and curl it**

Terminal 1:
```bash
ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
IRI_API_KEY=demo-key \
IRI_REGISTRATION_SECRET=demo-secret \
bun run dev
```

Terminal 2:
```bash
curl -s http://localhost:4000/healthz
# {"status":"ok"}

curl -s -H "Authorization: Bearer demo-key" http://localhost:4000/v1/models
# {"object":"list","data":[...]}
```

- [ ] **Step 4: End-to-end manual smoke**

Terminal 3:
```bash
cd examples/weather-app
IRI_REGISTRATION_SECRET=demo-secret bun run dev
```

Open <http://localhost:4001>, paste `demo-key`, ask a weather question. Confirm the tool is called and the model answers using the forecast data.
