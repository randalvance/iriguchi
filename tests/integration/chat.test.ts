import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
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
  maxAgentTurns: 5,
  toolCallTimeoutMs: 1000,
  manifestCacheTtlMs: 1000,
  requestTimeoutMs: 5000,
  dbPath: ":memory:",
  tmpDir: tmp,
  providers: {
    anthropic: { name: "anthropic", apiKey: "ak", baseUrl: "https://api.anthropic.com", defaultModel: "claude-sonnet-4-6" },
  } as Record<string, { name: string; apiKey: string; baseUrl: string; defaultModel: string }>,
  defaultProvider: "anthropic",
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
      const cfg = {
        ...baseCfg(),
        providers: {
          anthropic: { name: "anthropic", apiKey: "ak", baseUrl: `http://localhost:${fake.port}`, defaultModel: "claude-sonnet-4-6" },
        },
      };
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
      const cfg = {
        ...baseCfg(),
        providers: {
          anthropic: { name: "anthropic", apiKey: "ak", baseUrl: `http://localhost:${fake.port}`, defaultModel: "claude-sonnet-4-6" },
        },
      };
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
      const cfg = {
        ...baseCfg(),
        providers: {
          anthropic: { name: "anthropic", apiKey: "ak", baseUrl: `http://localhost:${fake.port}`, defaultModel: "claude-sonnet-4-6" },
        },
      };
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

  it("rejects malformed messages with 400", async () => {
    const app = buildApp({ config: baseCfg(), store });
    const res = await app.fetch(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer client-key" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          messages: [{ role: 42, content: "hi" }],
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.message).toMatch(/role and content/i);
  });

  it("rejects malformed JSON with 400", async () => {
    const app = buildApp({ config: baseCfg(), store });
    const res = await app.fetch(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer client-key" },
        body: "not-json",
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/chat/completions — non-streaming", () => {
  function cfgFor(fakePort: number | undefined) {
    return {
      ...baseCfg(),
      providers: {
        anthropic: {
          name: "anthropic",
          apiKey: "ak",
          baseUrl: `http://localhost:${fakePort}`,
          defaultModel: "claude-sonnet-4-6",
        },
      },
    };
  }

  function chatRequest(body: Record<string, unknown>, query = "") {
    return new Request(`http://x/v1/chat/completions${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer client-key" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        ...body,
      }),
    });
  }

  it("returns a chat.completion object for stream: false", async () => {
    const fake = spinUpFakeAnthropic({ turns: [{ kind: "text", text: "Hi there" }] });
    try {
      const app = buildApp({ config: cfgFor(fake.port), store });
      const res = await app.fetch(chatRequest({ stream: false }));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = (await res.json()) as any;
      expect(body.object).toBe("chat.completion");
      expect(body.id).toMatch(/^chatcmpl-/);
      expect(body.model).toBe("claude-sonnet-4-6");
      expect(typeof body.created).toBe("number");
      expect(body.choices).toHaveLength(1);
      expect(body.choices[0].index).toBe(0);
      expect(body.choices[0].message.role).toBe("assistant");
      expect(body.choices[0].message.content).toBe("Hi there");
      expect(body.choices[0].finish_reason).toBe("stop");
      expect(res.headers.get("X-Request-Id")).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    } finally {
      fake.stop();
    }
  });

  it("treats an absent stream field as non-streaming", async () => {
    const fake = spinUpFakeAnthropic({ turns: [{ kind: "text", text: "Hi there" }] });
    try {
      const app = buildApp({ config: cfgFor(fake.port), store });
      const res = await app.fetch(chatRequest({}));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = (await res.json()) as any;
      expect(body.object).toBe("chat.completion");
      expect(body.choices[0].message.content).toBe("Hi there");
    } finally {
      fake.stop();
    }
  });

  it("carries no SSE framing in the JSON body", async () => {
    const fake = spinUpFakeAnthropic({ turns: [{ kind: "text", text: "Hi there" }] });
    try {
      const app = buildApp({ config: cfgFor(fake.port), store });
      const res = await app.fetch(chatRequest({ stream: false }));
      const raw = await res.text();
      expect(raw).not.toContain("data: ");
      expect(raw).not.toContain("[DONE]");
      expect(JSON.parse(raw).object).toBe("chat.completion");
    } finally {
      fake.stop();
    }
  });

  it("aggregates the same text the streaming mode emits", async () => {
    const turns = [
      { kind: "text" as const, text: "Sunny" },
      { kind: "text" as const, text: ", 72°F." },
    ];
    const fakeA = spinUpFakeAnthropic({ turns });
    const fakeB = spinUpFakeAnthropic({ turns });
    try {
      const streamed = await app_fetchSse(buildApp({ config: cfgFor(fakeA.port), store }));
      const app = buildApp({ config: cfgFor(fakeB.port), store });
      const res = await app.fetch(chatRequest({ stream: false }));
      const body = (await res.json()) as any;
      expect(body.choices[0].message.content).toBe(streamed);
    } finally {
      fakeA.stop();
      fakeB.stop();
    }
  });

  it("rejects a non-boolean stream with 400 and runs no agent", async () => {
    let calls = 0;
    const fake = spinUpFakeAnthropic({ turns: [{ kind: "text", text: "unused" }] });
    const countingFake = Bun.serve({
      port: 0,
      fetch: (req) => {
        calls++;
        return fake.fetch(req);
      },
    });
    try {
      const app = buildApp({ config: cfgFor(countingFake.port), store });
      const res = await app.fetch(chatRequest({ stream: "yes" }));
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.message).toMatch(/stream/);
      expect(calls).toBe(0);
    } finally {
      countingFake.stop();
      fake.stop();
    }
  });

  it("returns unknown_agent as JSON in non-streaming mode", async () => {
    const fake = spinUpFakeAnthropic({ turns: [{ kind: "text", text: "unused" }] });
    try {
      const app = buildApp({ config: cfgFor(fake.port), store });
      const res = await app.fetch(chatRequest({ stream: false, iri_agent: "missing" }));
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = (await res.json()) as any;
      expect(body.error.code).toBe("unknown_agent");
      expect(res.headers.get("X-Request-Id")).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    } finally {
      fake.stop();
    }
  });

  it("returns JSON, not a partial completion, when the run fails mid-flight", async () => {
    // The run starts, then the provider refuses. Non-streaming has committed
    // no bytes at that point, so the failure must still become a status code.
    const rejecting = new Hono();
    rejecting.post("/v1/messages", () => Response.json({ error: "nope" }, { status: 400 }));
    const server = Bun.serve({ port: 0, fetch: rejecting.fetch });
    try {
      const app = buildApp({ config: cfgFor(server.port), store });
      const res = await app.fetch(chatRequest({ stream: false }));
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = (await res.json()) as any;
      expect(body.error.type).toBe("internal_error");
      expect(body.object).toBeUndefined();
      expect(body.choices).toBeUndefined();
      expect(res.headers.get("X-Request-Id")).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    } finally {
      server.stop();
    }
  });

  it("surfaces tool calls when iri_show_tool_calls=true", async () => {
    const fake = spinUpFakeAnthropic({
      responses: [
        [{ kind: "tool_use", id: "tu_1", name: "get_forecast", input: { location: "NYC" } }],
        [{ kind: "text", text: "Sunny, 72°F." }],
      ],
    });
    const appApp = new Hono();
    appApp.post("/api/forecast", () => Response.json({ temp_f: 72, condition: "sunny" }));
    const appServer = Bun.serve({ port: 0, fetch: appApp.fetch });
    try {
      registerWeatherBot(store, appServer.port);
      const app = buildApp({ config: cfgFor(fake.port), store });
      const res = await app.fetch(
        chatRequest({ stream: false, iri_agent: "weather-bot" }, "?iri_show_tool_calls=true"),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.choices[0].message.content).toContain("Sunny, 72°F.");
      expect(body.choices[0].message.tool_calls).toHaveLength(1);
      expect(body.choices[0].message.tool_calls[0].function.name).toBe("get_forecast");
      expect(body.choices[0].message.tool_calls[0].type).toBe("function");
      expect(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments)).toEqual({
        location: "NYC",
      });
    } finally {
      appServer.stop();
      fake.stop();
    }
  });

  it("omits tool_calls without iri_show_tool_calls", async () => {
    const fake = spinUpFakeAnthropic({
      responses: [
        [{ kind: "tool_use", id: "tu_1", name: "get_forecast", input: { location: "NYC" } }],
        [{ kind: "text", text: "Sunny, 72°F." }],
      ],
    });
    const appApp = new Hono();
    appApp.post("/api/forecast", () => Response.json({ temp_f: 72, condition: "sunny" }));
    const appServer = Bun.serve({ port: 0, fetch: appApp.fetch });
    try {
      registerWeatherBot(store, appServer.port);
      const app = buildApp({ config: cfgFor(fake.port), store });
      const res = await app.fetch(chatRequest({ stream: false, iri_agent: "weather-bot" }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.choices[0].message).not.toHaveProperty("tool_calls");
    } finally {
      appServer.stop();
      fake.stop();
    }
  });

  async function app_fetchSse(app: ReturnType<typeof buildApp>): Promise<string> {
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
    const raw = await readAllSse(res);
    return raw
      .split("\n")
      .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
      .map((l) => JSON.parse(l.slice(6)))
      .flatMap((chunk: any) => chunk.choices.map((ch: any) => ch.delta.content || ""))
      .join("");
  }
});

function registerWeatherBot(store: Store, appPort: number | undefined) {
  store.upsertApp({
    id: "weather-app",
    base_url: `http://localhost:${appPort}`,
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
              parameters: {
                type: "object",
                properties: { location: { type: "string" } },
                required: ["location"],
              },
              endpoint: { method: "POST", path: "/api/forecast" },
            },
          ],
          skills: [],
        },
      ],
    },
  });
}
