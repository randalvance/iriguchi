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
    const fake = spinUpFakeAnthropic({
      // First API call → tool_use; second API call (after tool result) → text answer.
      responses: [
        [{ kind: "tool_use", id: "tu_1", name: "get_forecast", input: { location: "NYC" } }],
        [{ kind: "text", text: "Sunny, 72°F." }],
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
        request: { requestId: "01H", agentId: "weather-bot", model: null, messages: [{ role: "user", content: "weather in NYC?" }], showToolCalls: false },
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
        request: { requestId: "01H", agentId: "missing-bot", model: null, messages: [{ role: "user", content: "x" }], showToolCalls: false },
      });
      await expect(collect(stream)).rejects.toMatchObject({ httpStatus: 404 });
    } finally {
      fake.stop();
    }
  });
});
