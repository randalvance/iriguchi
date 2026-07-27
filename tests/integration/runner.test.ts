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
  tmpDir: tmp,
  maxAgentTurns: 5,
  toolCallTimeoutMs: 1000,
  providers: {
    anthropic: {
      name: "anthropic",
      apiKey: "ak-test",
      baseUrl: "https://api.anthropic.com",
      defaultModel: "claude-sonnet-4-6",
      authStyle: "api_key" as const,
    },
  } as Record<string, { name: string; apiKey: string; baseUrl: string; defaultModel: string; authStyle: "api_key" }>,
  defaultProvider: "anthropic",
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
        config: {
          ...baseConfig(),
          providers: {
            anthropic: { name: "anthropic", apiKey: "ak-test", baseUrl: `http://localhost:${fake.port}`, defaultModel: "claude-sonnet-4-6", authStyle: "api_key" as const },
          },
        },
        store,
        request: { requestId: "01H", agentId: null, model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }], showToolCalls: false },
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
    // Scripted by content, not call index: the SDK issues a preliminary
    // tool-less call before the agent turn, so index-based scripting hands the
    // tool_use to a request that declared no tools. The run still emits the
    // scripted final text, so asserting on output alone passes while the app is
    // never called — which is exactly what this test used to do.
    const fake = spinUpFakeAnthropic({
      respond: (body: any) => {
        const declaresAppTool = (body.tools ?? []).some(
          (t: any) => t.name === "mcp__app__get_forecast",
        );
        const sawToolResult = JSON.stringify(body.messages ?? []).includes("tool_result");
        if (!declaresAppTool) return [{ kind: "text", text: "" }];
        if (!sawToolResult) {
          return [
            {
              kind: "tool_use",
              id: "tu_1",
              name: "mcp__app__get_forecast",
              input: { location: "NYC" },
            },
          ];
        }
        return [{ kind: "text", text: "Sunny, 72°F." }];
      },
    });
    const appCalls: unknown[] = [];
    const appApp = new Hono();
    appApp.post("/api/forecast", async (c) => {
      appCalls.push(await c.req.json());
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
        config: {
          ...baseConfig(),
          providers: {
            anthropic: { name: "anthropic", apiKey: "ak-test", baseUrl: `http://localhost:${fake.port}`, defaultModel: "claude-sonnet-4-6", authStyle: "api_key" as const },
          },
        },
        store,
        request: { requestId: "01H", agentId: "weather-bot", model: null, messages: [{ role: "user", content: "weather in NYC?" }], showToolCalls: false },
      });
      const out = await collect(stream);
      // Assert the app was actually reached, not merely that the scripted text
      // came back — the latter is true even when the tool never runs.
      expect(appCalls).toEqual([{ location: "NYC" }]);
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
        config: {
          ...baseConfig(),
          providers: {
            anthropic: { name: "anthropic", apiKey: "ak-test", baseUrl: `http://localhost:${fake.port}`, defaultModel: "claude-sonnet-4-6", authStyle: "api_key" as const },
          },
        },
        store,
        request: { requestId: "01H", agentId: "missing-bot", model: null, messages: [{ role: "user", content: "x" }], showToolCalls: false },
      });
      await expect(collect(stream)).rejects.toMatchObject({ httpStatus: 404 });
    } finally {
      fake.stop();
    }
  });
});

describe("runAgentStream — agent.provider resolution", () => {
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
            anthropic: { name: "anthropic", apiKey: "ak", baseUrl: `http://localhost:${fakeDefault.port}`, defaultModel: "claude-sonnet-4-6", authStyle: "api_key" as const },
            alt: { name: "alt", apiKey: "ak-alt", baseUrl: `http://localhost:${fakeAlt.port}`, defaultModel: "claude-sonnet-4-6", authStyle: "api_key" as const },
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

  it("agent with provider but no default_model inherits the routed provider's default model", async () => {
    const fakeDefault = spinUpFakeAnthropic({ turns: [{ kind: "text", text: "unused" }] });
    const fakeAlt = spinUpFakeAnthropic({ turns: [{ kind: "text", text: "hello" }] });
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
            anthropic: {
              name: "anthropic",
              apiKey: "ak",
              baseUrl: `http://localhost:${fakeDefault.port}`,
              defaultModel: "claude-opus-5",
              authStyle: "api_key" as const,
            },
            alt: {
              name: "alt",
              apiKey: "ak-alt",
              baseUrl: `http://localhost:${fakeAlt.port}`,
              defaultModel: "alt-model-9000",
              authStyle: "api_key" as const,
            },
          },
          defaultProvider: "anthropic",
        },
        store,
        request: { requestId: "01H", agentId: "alt-bot", model: null, messages: [{ role: "user", content: "hi" }], showToolCalls: false },
      });
      const out = await collect(stream);
      // The SSE chunks carry the resolved model id.
      expect(out).toContain("alt-model-9000");
      expect(out).not.toContain("claude-opus-5");
    } finally {
      fakeDefault.stop();
      fakeAlt.stop();
    }
  });
});
