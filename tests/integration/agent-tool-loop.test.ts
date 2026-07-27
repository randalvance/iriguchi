import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { createStore, type Store } from "../../src/registry/store.ts";
import { runAgentChunks } from "../../src/agent/runner.ts";
import { spinUpFakeAnthropic } from "../helpers/fake-anthropic.ts";
import type { OpenAIChunk } from "../../src/agent/openai-sse.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The full tool loop end to end against a scripted provider: an agent declares
 * an `api_call` tool, the model elects to call it, the gateway calls the owning
 * app, the result is handed back, and the final answer derives from it. Runs in
 * the default suite — no credentials, no network beyond localhost.
 *
 * Scripting here is content-aware rather than call-indexed, and that is
 * load-bearing. The SDK issues a preliminary tool-less call before the agent
 * turn, so index-based scripting hands the tool_use to a request that declared
 * no tools; the run still produces the scripted final text, so an assertion on
 * output alone passes while the app is never called at all.
 */

const APP_TOOL = "mcp__app__get_forecast";

let tmp: string;
let store: Store;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "iri-tool-loop-"));
  store = createStore({ dbPath: ":memory:" });
});
afterEach(async () => {
  store.close();
  await rm(tmp, { recursive: true, force: true });
});

type AppRequest = { path: string; auth: string | null; body: unknown };

function spinUpStubApp(reply: () => Response, received: AppRequest[]) {
  const app = new Hono();
  app.post("/api/forecast", async (c) => {
    received.push({
      path: "/api/forecast",
      auth: c.req.header("Authorization") ?? null,
      body: await c.req.json().catch(() => null),
    });
    return reply();
  });
  return Bun.serve({ port: 0, fetch: app.fetch });
}

const FORECAST_TOOL = {
  type: "api_call",
  name: "get_forecast",
  description: "get forecast",
  parameters: {
    type: "object",
    properties: { location: { type: "string" } },
    required: ["location"],
  },
  endpoint: { method: "POST", path: "/api/forecast" },
};

function registerToolAgent(appPort: number | undefined, tools: unknown[]) {
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
          tools,
          skills: [],
        },
      ],
    } as never,
  });
}

/** Call the tool on the first turn that declares it, then answer from its result. */
function toolThenAnswer(answer: string) {
  return (body: any) => {
    const declaresAppTool = (body.tools ?? []).some((t: any) => t.name === APP_TOOL);
    const sawToolResult = JSON.stringify(body.messages ?? []).includes("tool_result");
    if (!declaresAppTool) return [{ kind: "text" as const, text: "" }];
    if (!sawToolResult) {
      return [
        { kind: "tool_use" as const, id: "tu_1", name: APP_TOOL, input: { location: "NYC" } },
      ];
    }
    return [{ kind: "text" as const, text: answer }];
  };
}

function configFor(fakePort: number | undefined) {
  return {
    tmpDir: tmp,
    maxAgentTurns: 5,
    toolCallTimeoutMs: 2000,
    providers: {
      anthropic: {
        name: "anthropic",
        apiKey: "ak-test",
        baseUrl: `http://localhost:${fakePort}`,
        defaultModel: "claude-sonnet-4-6",
        authStyle: "api_key" as const,
      },
    },
    defaultProvider: "anthropic",
  };
}

function run(fakePort: number | undefined, showToolCalls = false) {
  return runAgentChunks({
    config: configFor(fakePort),
    store,
    request: {
      requestId: "01H",
      agentId: "weather-bot",
      model: null,
      messages: [{ role: "user", content: "weather in NYC?" }],
      showToolCalls,
    },
  });
}

async function collectText(chunks: AsyncIterable<OpenAIChunk>): Promise<string> {
  let text = "";
  for await (const chunk of chunks) {
    for (const choice of chunk.choices) text += choice.delta.content ?? "";
  }
  return text;
}

describe("agent tool loop", () => {
  it("declares the tool, calls the app, and derives its answer from the result", async () => {
    const declaredTools: string[][] = [];
    const fake = spinUpFakeAnthropic(
      { respond: toolThenAnswer("Sunny, 72F in NYC.") },
      { onRequest: (r) => declaredTools.push((r.body?.tools ?? []).map((t: any) => t.name)) },
    );
    const received: AppRequest[] = [];
    const appServer = spinUpStubApp(
      () => Response.json({ temp_f: 72, condition: "sunny" }),
      received,
    );
    try {
      registerToolAgent(appServer.port, [FORECAST_TOOL]);
      const text = await collectText(run(fake.port));

      // Stage 1 — exposure: the manifest tool reached the model as an app tool.
      expect(declaredTools.some((names) => names.includes(APP_TOOL))).toBe(true);

      // Stage 2 — app request: right path, right credential, model-built args.
      expect(received).toHaveLength(1);
      expect(received[0].path).toBe("/api/forecast");
      expect(received[0].auth).toBe("Bearer app-tok");
      expect(received[0].body).toEqual({ location: "NYC" });

      // Stage 3 — the result came back and shaped the final answer.
      expect(text).toContain("Sunny, 72F in NYC.");
    } finally {
      appServer.stop();
      fake.stop();
    }
  });

  it("keeps running when the app tool fails, instead of aborting", async () => {
    const fake = spinUpFakeAnthropic({
      respond: toolThenAnswer("I could not reach the forecast service."),
    });
    const received: AppRequest[] = [];
    const appServer = spinUpStubApp(
      () => Response.json({ message: "boom" }, { status: 500 }),
      received,
    );
    try {
      registerToolAgent(appServer.port, [FORECAST_TOOL]);
      const text = await collectText(run(fake.port));

      // Called, and retried once on 5xx per the tool contract.
      expect(received.length).toBe(2);
      // The error became a tool result rather than aborting the run.
      expect(text).toContain("I could not reach the forecast service.");
    } finally {
      appServer.stop();
      fake.stop();
    }
  });

  it("makes no app request for an agent that declares no tools", async () => {
    const declaredTools: string[][] = [];
    const fake = spinUpFakeAnthropic(
      { turns: [{ kind: "text", text: "No tools needed." }] },
      { onRequest: (r) => declaredTools.push((r.body?.tools ?? []).map((t: any) => t.name)) },
    );
    const received: AppRequest[] = [];
    const appServer = spinUpStubApp(() => Response.json({ unreachable: true }), received);
    try {
      registerToolAgent(appServer.port, []);
      const text = await collectText(run(fake.port));

      expect(declaredTools.every((names) => !names.some((n) => n.startsWith("mcp__app__")))).toBe(
        true,
      );
      expect(received).toHaveLength(0);
      expect(text).toContain("No tools needed.");
    } finally {
      appServer.stop();
      fake.stop();
    }
  });

  it("surfaces the invocation as a tool_call when visibility is requested", async () => {
    const fake = spinUpFakeAnthropic({ respond: toolThenAnswer("Sunny.") });
    const received: AppRequest[] = [];
    const appServer = spinUpStubApp(() => Response.json({ temp_f: 72 }), received);
    try {
      registerToolAgent(appServer.port, [FORECAST_TOOL]);
      const calls: Array<{ name: string; arguments: string }> = [];
      for await (const chunk of run(fake.port, true)) {
        for (const choice of chunk.choices) {
          for (const call of choice.delta.tool_calls ?? []) calls.push(call.function);
        }
      }

      expect(received).toHaveLength(1);
      // Names surface with the gateway's MCP prefix, as the runtime reports them.
      expect(calls.map((c) => c.name)).toContain(APP_TOOL);
      expect(JSON.parse(calls[0].arguments)).toEqual({ location: "NYC" });
    } finally {
      appServer.stop();
      fake.stop();
    }
  });
});
