import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildApp } from "../../src/server.ts";
import { createStore, type Store } from "../../src/registry/store.ts";
import { createLogger, type LogEvent } from "../../src/logger.ts";
import { spinUpFakeAnthropic } from "../helpers/fake-anthropic.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The `iri_context` request field at the HTTP boundary: what is accepted, what
 * is refused and how, and what reaches the log. Run-level behavior — the
 * prompt block, the `get_context` tool, `when` gating — lives in
 * `context-run.test.ts`, which drives the runner directly.
 */

let tmp: string;
let store: Store;
let events: LogEvent[];

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "iri-chat-ctx-"));
  store = createStore({ dbPath: ":memory:" });
  events = [];
});
afterEach(async () => {
  store.close();
  await rm(tmp, { recursive: true, force: true });
});

const cfgFor = (fakePort: number | undefined, overrides: Record<string, unknown> = {}) => ({
  port: 0,
  maxAgentTurns: 5,
  toolCallTimeoutMs: 1000,
  manifestCacheTtlMs: 1000,
  mcpCacheTtlMs: 300_000,
  maxContextBytes: 65536,
  mcpAllowedOrigins: [] as string[],
  requestTimeoutMs: 5000,
  dbPath: ":memory:",
  tmpDir: tmp,
  providers: {
    anthropic: {
      name: "anthropic",
      apiKey: "ak",
      baseUrl: `http://localhost:${fakePort}`,
      defaultModel: "claude-sonnet-4-6",
      authStyle: "api_key" as const,
    },
  },
  defaultProvider: "anthropic",
  apiKey: "client-key",
  uiEnabled: false,
  uiDist: "./ui/dist",
  registrationSecret: "reg",
  ...overrides,
});

function post(app: ReturnType<typeof buildApp>, body: unknown) {
  return app.fetch(
    new Request("http://x/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer client-key" },
      body: JSON.stringify(body),
    }),
  );
}

function appWith(fakePort: number | undefined, overrides: Record<string, unknown> = {}) {
  return buildApp({
    config: cfgFor(fakePort, overrides) as never,
    store,
    logger: createLogger({ sink: (e) => events.push(e) }),
  });
}

const USER = [{ role: "user", content: "hi" }];

describe("iri_context validation", () => {
  it("accepts a context on a non-streaming request and does not echo it", async () => {
    const fake = spinUpFakeAnthropic({ turns: [{ kind: "text", text: "Hi there" }] });
    try {
      const res = await post(appWith(fake.port), {
        model: "claude-sonnet-4-6",
        messages: USER,
        iri_context: { route: "/accounts/acc_42", account_id: "acc_42" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.object).toBe("chat.completion");
      expect(body.choices[0].message.content).toContain("Hi there");
      expect(JSON.stringify(body)).not.toContain("acc_42");
    } finally {
      fake.stop();
    }
  });

  it("accepts a context on a vanilla request with no iri_agent", async () => {
    const fake = spinUpFakeAnthropic({ turns: [{ kind: "text", text: "ok" }] });
    try {
      const res = await post(appWith(fake.port), {
        model: "claude-sonnet-4-6",
        messages: USER,
        iri_context: { route: "/x" },
      });
      expect(res.status).toBe(200);
    } finally {
      fake.stop();
    }
  });

  it.each([
    ["an array", []],
    ["a string", "route=/x"],
    ["a number", 7],
    ["null", null],
  ])("rejects %s with 400 invalid_context before any run", async (_label, value) => {
    let providerCalled = false;
    const fake = spinUpFakeAnthropic(
      { turns: [{ kind: "text", text: "should not happen" }] },
      { onRequest: () => (providerCalled = true) },
    );
    try {
      const res = await post(appWith(fake.port), {
        model: "claude-sonnet-4-6",
        messages: USER,
        iri_context: value,
      });
      expect(res.status).toBe(400);
      expect(res.headers.get("Content-Type")).toContain("application/json");
      const body = (await res.json()) as any;
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.code).toBe("invalid_context");
      expect(providerCalled).toBe(false);
    } finally {
      fake.stop();
    }
  });

  it("rejects an invalid context as JSON even when stream is true", async () => {
    const fake = spinUpFakeAnthropic({ turns: [{ kind: "text", text: "x" }] });
    try {
      const res = await post(appWith(fake.port), {
        model: "claude-sonnet-4-6",
        messages: USER,
        stream: true,
        iri_context: "not an object",
      });
      expect(res.status).toBe(400);
      expect(res.headers.get("Content-Type")).toContain("application/json");
      expect(res.headers.get("Content-Type")).not.toContain("event-stream");
      expect(((await res.json()) as any).error.code).toBe("invalid_context");
    } finally {
      fake.stop();
    }
  });

  it("rejects an oversized context with context_too_large, naming limit and size", async () => {
    const fake = spinUpFakeAnthropic({ turns: [{ kind: "text", text: "x" }] });
    try {
      const res = await post(appWith(fake.port, { maxContextBytes: 64 }), {
        model: "claude-sonnet-4-6",
        messages: USER,
        stream: false,
        iri_context: { blob: "x".repeat(500) },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.error.code).toBe("context_too_large");
      expect(body.error.message).toMatch(/\b64\b/);
      expect(body.error.message).toMatch(/\b5\d\d\b/);
    } finally {
      fake.stop();
    }
  });

  it("leaves the response shape unchanged when the context is absent", async () => {
    const fake = spinUpFakeAnthropic({ turns: [{ kind: "text", text: "Hi there" }] });
    try {
      const res = await post(appWith(fake.port), { model: "claude-sonnet-4-6", messages: USER });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.object).toBe("chat.completion");
      expect(body.choices[0].message.content).toContain("Hi there");
      expect(body.choices[0].finish_reason).toBe("stop");
    } finally {
      fake.stop();
    }
  });

  it("still returns 404 unknown_agent when an unknown agent carries a valid context", async () => {
    const fake = spinUpFakeAnthropic({ turns: [{ kind: "text", text: "x" }] });
    try {
      const res = await post(appWith(fake.port), {
        model: "claude-sonnet-4-6",
        messages: USER,
        iri_agent: "nope",
        iri_context: { route: "/x" },
      });
      expect(res.status).toBe(404);
      expect(((await res.json()) as any).error.code).toBe("unknown_agent");
    } finally {
      fake.stop();
    }
  });
});

describe("context logging", () => {
  it("logs key names and byte size, never values", async () => {
    const fake = spinUpFakeAnthropic({ turns: [{ kind: "text", text: "ok" }] });
    try {
      await post(appWith(fake.port), {
        model: "claude-sonnet-4-6",
        messages: USER,
        iri_context: {
          account_id: "acc_SECRET_42",
          account_name: "Chase Checking",
          rows: [{ description: "SQ *BLUE BOTTLE", amount: -6.75 }],
        },
      });
      const start = events.find((e) => e.event === "request.start")!;
      expect(start.context_keys).toEqual(["account_id", "account_name", "rows"]);
      expect(typeof start.context_bytes).toBe("number");
      expect(start.context_bytes as number).toBeGreaterThan(0);

      // Nothing anywhere in the emitted records carries a value.
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain("acc_SECRET_42");
      expect(serialized).not.toContain("Chase Checking");
      expect(serialized).not.toContain("BLUE BOTTLE");
    } finally {
      fake.stop();
    }
  });

  it("reports no keys and zero bytes when the context is absent", async () => {
    const fake = spinUpFakeAnthropic({ turns: [{ kind: "text", text: "ok" }] });
    try {
      await post(appWith(fake.port), { model: "claude-sonnet-4-6", messages: USER });
      const start = events.find((e) => e.event === "request.start")!;
      expect(start.context_keys).toEqual([]);
      expect(start.context_bytes).toBe(2); // "{}"
    } finally {
      fake.stop();
    }
  });
});
