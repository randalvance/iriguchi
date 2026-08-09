import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createStore, type Store } from "../../src/registry/store.ts";
import { runAgentChunks } from "../../src/agent/runner.ts";
import { createMcpRuntime } from "../../src/agent/mcp/index.ts";
import type { McpRuntime } from "../../src/agent/mcp/discovery.ts";
import { createLogger } from "../../src/logger.ts";
import { spinUpFakeAnthropic } from "../helpers/fake-anthropic.ts";
import {
  spinUpFakeMcpServer,
  unreachableMcpUrl,
  type FakeMcpServer,
} from "../helpers/fake-mcp-server.ts";
import type { OpenAIChunk } from "../../src/agent/openai-sse.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The MCP tool loop end to end against a scripted provider: an agent declares
 * an `mcp` server, the gateway discovers its tools, the model elects to call
 * one, the gateway issues `tools/call`, and the final answer derives from the
 * result. Runs in the default suite — no credentials, no reachable MCP server
 * beyond localhost.
 *
 * The sibling `agent-tool-loop.test.ts` covers the same stages for `api_call`;
 * the scripting here is content-aware for the same reason it is there. The SDK
 * issues a preliminary tool-less call before the agent turn, so index-based
 * scripting would hand the tool_use to a request declaring no tools and the
 * test would pass without the server ever being called.
 */

const EXPOSED = "mcp__app__finance__list_accounts";

let tmp: string;
let store: Store;
const runtimes: McpRuntime[] = [];
const servers: FakeMcpServer[] = [];

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "iri-mcp-loop-"));
  store = createStore({ dbPath: ":memory:" });
});
afterEach(async () => {
  store.close();
  await Promise.all(runtimes.splice(0).map((rt) => rt.pool.closeAll()));
  await Promise.all(servers.splice(0).map((s) => s.stop()));
  await rm(tmp, { recursive: true, force: true });
});

function mcpRuntime(): McpRuntime {
  const rt = createMcpRuntime({
    config: { mcpCacheTtlMs: 300_000, mcpAllowedOrigins: [] },
    logger: createLogger({ sink: () => {} }),
  });
  runtimes.push(rt);
  return rt;
}

function mcpServer(opts: Parameters<typeof spinUpFakeMcpServer>[0] = {}) {
  const s = spinUpFakeMcpServer(opts);
  servers.push(s);
  return s;
}

function registerAgent(tools: unknown[]) {
  store.upsertApp({
    id: "finance-app",
    base_url: "http://localhost:1",
    app_token: "app-tok",
    manifest: {
      manifest_version: "1",
      app: { id: "finance-app", name: "f", description: "f" },
      agents: [
        {
          id: "finance-bot",
          name: "Bot",
          description: "d",
          system_prompt: "you are a finance bot",
          tools,
          skills: [],
        },
      ],
    } as never,
  });
}

/** Call the named tool on the first turn that declares it, then answer. */
function toolThenAnswer(toolName: string, answer: string, input: unknown = {}) {
  return (body: any) => {
    const declared = (body.tools ?? []).some((t: any) => t.name === toolName);
    const sawResult = JSON.stringify(body.messages ?? []).includes("tool_result");
    if (!declared) return [{ kind: "text" as const, text: "" }];
    if (!sawResult) {
      return [{ kind: "tool_use" as const, id: "tu_1", name: toolName, input }];
    }
    return [{ kind: "text" as const, text: answer }];
  };
}

function run(fakePort: number | undefined, mcp?: McpRuntime) {
  return runAgentChunks({
    config: {
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
    },
    store,
    mcp,
    request: {
      requestId: "01H",
      agentId: "finance-bot",
      model: null,
      messages: [{ role: "user", content: "what accounts do I have?" }],
      showToolCalls: false,
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

describe("MCP agent loop", () => {
  it("discovers, exposes, calls, and derives its answer from the result", async () => {
    const declaredTools: string[][] = [];
    const server = mcpServer({
      tools: [{ name: "list_accounts", description: "List every financial account." }],
      behaviors: {
        list_accounts: { kind: "json", data: { accounts: [{ id: 21, name: "Coinhako" }] } },
      },
    });
    const fake = spinUpFakeAnthropic(
      { respond: toolThenAnswer(EXPOSED, "You have one account: Coinhako.") },
      { onRequest: (r) => declaredTools.push((r.body?.tools ?? []).map((t: any) => t.name)) },
    );
    try {
      registerAgent([{ type: "mcp", name: "finance", url: server.url, headers: {} }]);
      const text = await collectText(run(fake.port, mcpRuntime()));

      // Stage 1 — discovery: the gateway asked the server what it has.
      expect(server.countOf("tools/list")).toBeGreaterThanOrEqual(1);

      // Stage 2 — exposure: it reached the model under its prefixed name.
      expect(declaredTools.some((names) => names.includes(EXPOSED))).toBe(true);

      // Stage 3 — invocation: tools/call used the server's own name.
      expect(server.calls).toHaveLength(1);
      expect(server.calls[0].name).toBe("list_accounts");

      // Stage 4 — the result came back and shaped the final answer.
      expect(text).toContain("You have one account: Coinhako.");
    } finally {
      fake.stop();
    }
  });

  it("passes model-generated arguments through to the server", async () => {
    const server = mcpServer({
      tools: [{ name: "get_transaction", inputSchema: { type: "object", properties: { id: { type: "integer" } } } }],
    });
    const exposed = "mcp__app__finance__get_transaction";
    const fake = spinUpFakeAnthropic({ respond: toolThenAnswer(exposed, "done", { id: 42 }) });
    try {
      registerAgent([{ type: "mcp", name: "finance", url: server.url, headers: {} }]);
      await collectText(run(fake.port, mcpRuntime()));
      expect(server.calls[0].arguments).toEqual({ id: 42 });
    } finally {
      fake.stop();
    }
  });

  it("hands an isError result to the model without aborting the run", async () => {
    const server = mcpServer({
      tools: [{ name: "list_accounts" }],
      behaviors: {
        list_accounts: { kind: "tool_error", text: "Failed query: select * from accounts" },
      },
    });
    let toolResultSeen: string | null = null;
    const fake = spinUpFakeAnthropic(
      { respond: toolThenAnswer(EXPOSED, "The finance service is having trouble.") },
      {
        onRequest: (r) => {
          const serialized = JSON.stringify(r.body?.messages ?? []);
          if (serialized.includes("tool_result")) toolResultSeen = serialized;
        },
      },
    );
    try {
      registerAgent([{ type: "mcp", name: "finance", url: server.url, headers: {} }]);
      const text = await collectText(run(fake.port, mcpRuntime()));

      expect(toolResultSeen).toContain("mcp_tool_error");
      expect(toolResultSeen).toContain("Failed query");
      // The run completed rather than erroring out.
      expect(text).toContain("The finance service is having trouble.");
    } finally {
      fake.stop();
    }
  });

  it("exposes both api_call and mcp tools on one agent", async () => {
    const server = mcpServer({ tools: [{ name: "list_accounts" }] });
    const declaredTools: string[][] = [];
    const fake = spinUpFakeAnthropic(
      { respond: () => [{ kind: "text" as const, text: "hi" }] },
      { onRequest: (r) => declaredTools.push((r.body?.tools ?? []).map((t: any) => t.name)) },
    );
    try {
      registerAgent([
        {
          type: "api_call",
          name: "get_forecast",
          description: "d",
          parameters: { type: "object", properties: {} },
          endpoint: { method: "POST", path: "/api/forecast" },
        },
        { type: "mcp", name: "finance", url: server.url, headers: {} },
      ]);
      await collectText(run(fake.port, mcpRuntime()));
      const withTools = declaredTools.find((names) => names.length > 0) ?? [];
      expect(withTools).toContain("mcp__app__get_forecast");
      expect(withTools).toContain(EXPOSED);
    } finally {
      fake.stop();
    }
  });
});

describe("MCP agent loop — degradation", () => {
  it("keeps api_call tools working when the mcp server is unreachable", async () => {
    const declaredTools: string[][] = [];
    const fake = spinUpFakeAnthropic(
      { respond: () => [{ kind: "text" as const, text: "still here" }] },
      { onRequest: (r) => declaredTools.push((r.body?.tools ?? []).map((t: any) => t.name)) },
    );
    try {
      registerAgent([
        {
          type: "api_call",
          name: "get_forecast",
          description: "d",
          parameters: { type: "object", properties: {} },
          endpoint: { method: "POST", path: "/api/forecast" },
        },
        { type: "mcp", name: "finance", url: await unreachableMcpUrl(), headers: {} },
      ]);
      const text = await collectText(run(fake.port, mcpRuntime()));
      // The gateway's own tools are what matter; the SDK adds built-ins of its
      // own alongside them.
      const gatewayTools = declaredTools
        .flat()
        .filter((n) => n.startsWith("mcp__app__"));
      expect(gatewayTools).toContain("mcp__app__get_forecast");
      expect(gatewayTools).not.toContain(EXPOSED);
      expect(text).toContain("still here");
    } finally {
      fake.stop();
    }
  });

  it("still answers when an mcp-only agent's server is down", async () => {
    const fake = spinUpFakeAnthropic({
      respond: () => [{ kind: "text" as const, text: "I have no tools right now." }],
    });
    try {
      registerAgent([
        { type: "mcp", name: "finance", url: await unreachableMcpUrl(), headers: {} },
      ]);
      const text = await collectText(run(fake.port, mcpRuntime()));
      expect(text).toContain("I have no tools right now.");
    } finally {
      fake.stop();
    }
  });

  it("contributes no tools when the gateway has no mcp runtime at all", async () => {
    const server = mcpServer({ tools: [{ name: "list_accounts" }] });
    const declaredTools: string[][] = [];
    const fake = spinUpFakeAnthropic(
      { respond: () => [{ kind: "text" as const, text: "ok" }] },
      { onRequest: (r) => declaredTools.push((r.body?.tools ?? []).map((t: any) => t.name)) },
    );
    try {
      registerAgent([{ type: "mcp", name: "finance", url: server.url, headers: {} }]);
      await collectText(run(fake.port, undefined));
      expect(declaredTools.every((names) => !names.includes(EXPOSED))).toBe(true);
      expect(server.methods).toEqual([]);
    } finally {
      fake.stop();
    }
  });
});
