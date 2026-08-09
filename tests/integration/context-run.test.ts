import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { createStore, type Store } from "../../src/registry/store.ts";
import { runAgentChunks } from "../../src/agent/runner.ts";
import { createMcpRuntime } from "../../src/agent/mcp/index.ts";
import type { McpRuntime } from "../../src/agent/mcp/discovery.ts";
import { createLogger, type LogEvent } from "../../src/logger.ts";
import { spinUpFakeAnthropic } from "../helpers/fake-anthropic.ts";
import { spinUpFakeMcpServer, type FakeMcpServer } from "../helpers/fake-mcp-server.ts";
import type { OpenAIChunk } from "../../src/agent/openai-sse.ts";
import { listen } from "../helpers/listen.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Client context inside a run, against a scripted provider: what reaches the
 * system prompt, what `get_context` serves, and which tools a `when` clause
 * admits. Runs in the default suite — no credentials, no network beyond
 * localhost.
 *
 * Scripting is content-aware throughout, for the reason the sibling tool-loop
 * tests give: the SDK issues a preliminary tool-less call before the agent
 * turn, so index-based scripting misaligns and lets a test pass without the
 * thing under test ever happening. Several assertions go further and have the
 * scripted model *read* what it was given — an account id pulled out of the
 * system prompt it actually received is proof the context arrived, in a way an
 * assertion on the request body alone is not.
 */

const GET_CONTEXT = "mcp__app__get_context";
const SPENDING_TOOL = "mcp__app__get_account_spending";
const IMPORT_TOOL = "mcp__app__apply_import_mapping";

let tmp: string;
let store: Store;
let events: LogEvent[];
const runtimes: McpRuntime[] = [];
const mcpServers: FakeMcpServer[] = [];

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "iri-ctx-run-"));
  store = createStore({ dbPath: ":memory:" });
  events = [];
});
afterEach(async () => {
  store.close();
  await Promise.all(runtimes.splice(0).map((rt) => rt.pool.closeAll()));
  await Promise.all(mcpServers.splice(0).map((s) => s.stop()));
  await rm(tmp, { recursive: true, force: true });
});

const SPENDING = {
  type: "api_call",
  name: "get_account_spending",
  description: "total spending for an account over a period",
  parameters: {
    type: "object",
    properties: { account_id: { type: "string" }, period: { type: "string" } },
    required: ["account_id"],
  },
  endpoint: { method: "POST", path: "/api/spending" },
};

/** Typed loosely so tests can swap in each `when` matcher form by spreading. */
const IMPORT_MAPPING: Record<string, unknown> = {
  type: "api_call",
  name: "apply_import_mapping",
  description: "apply inferred categories and accounts to a staged import",
  parameters: {
    type: "object",
    properties: { import_batch_id: { type: "string" } },
    required: ["import_batch_id"],
  },
  endpoint: { method: "POST", path: "/api/imports/apply" },
  when: { route: "/imports/preview" },
};

function registerAgent(tools: unknown[], appPort?: number) {
  store.upsertApp({
    id: "finance-app",
    base_url: `http://localhost:${appPort ?? 1}`,
    app_token: "app-tok",
    manifest: {
      manifest_version: "1",
      app: { id: "finance-app", name: "f", description: "f" },
      agents: [
        {
          id: "finance-bot",
          name: "Finance Bot",
          description: "d",
          system_prompt: "You are a finance assistant.",
          tools,
          skills: [],
        },
      ],
    } as never,
  });
}

type AppRequest = { path: string; body: unknown };

function stubApp(received: AppRequest[], reply: () => Response) {
  const app = new Hono();
  app.post("/api/spending", async (c) => {
    received.push({ path: "/api/spending", body: await c.req.json().catch(() => null) });
    return reply();
  });
  app.post("/api/imports/apply", async (c) => {
    received.push({ path: "/api/imports/apply", body: await c.req.json().catch(() => null) });
    return reply();
  });
  return listen({ port: 0, fetch: app.fetch });
}

function mcpRuntime(): McpRuntime {
  const rt = createMcpRuntime({
    config: { mcpCacheTtlMs: 300_000, mcpAllowedOrigins: [] },
    logger: createLogger({ sink: () => {} }),
  });
  runtimes.push(rt);
  return rt;
}

function run(
  fakePort: number | undefined,
  opts: {
    context?: Record<string, unknown>;
    showToolCalls?: boolean;
    mcp?: McpRuntime;
    message?: string;
  } = {},
) {
  return runAgentChunks({
    config: {
      tmpDir: tmp,
      maxAgentTurns: 6,
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
    mcp: opts.mcp,
    logger: createLogger({ sink: (e) => events.push(e) }),
    request: {
      requestId: "01H",
      agentId: "finance-bot",
      model: null,
      messages: [{ role: "user", content: opts.message ?? "what was the total spending?" }],
      showToolCalls: opts.showToolCalls ?? false,
      context: opts.context,
    },
  });
}

async function collect(chunks: AsyncIterable<OpenAIChunk>) {
  let text = "";
  const toolCalls: Array<{ name?: string; args: string }> = [];
  for await (const chunk of chunks) {
    for (const choice of chunk.choices) {
      text += choice.delta.content ?? "";
      for (const tc of (choice.delta as any).tool_calls ?? []) {
        const slot = (toolCalls[tc.index] ??= { args: "" });
        if (tc.function?.name) slot.name = tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
      }
    }
  }
  return { text, toolCalls };
}

/** The system prompt as the provider received it, flattened to a string. */
function systemOf(body: any): string {
  const s = body?.system;
  if (typeof s === "string") return s;
  if (Array.isArray(s)) return s.map((b: any) => b?.text ?? "").join("\n");
  return "";
}

const AGENT_PROMPT = "You are a finance assistant.";

/**
 * The system prompts of the agent's own turns.
 *
 * The SDK issues auxiliary calls around the agent turn with system prompts of
 * its own, and they arrive at the same fake provider. Taking the last request
 * would assert against one of those and pass or fail for reasons unrelated to
 * the context block, so turns are selected by the agent's prompt.
 */
function agentPrompts(bodies: any[]): string[] {
  return bodies.map(systemOf).filter((s) => s.includes(AGENT_PROMPT));
}

const toolNames = (body: any): string[] => (body?.tools ?? []).map((t: any) => t.name);
const sawToolResult = (body: any) => JSON.stringify(body?.messages ?? []).includes("tool_result");

describe("context in the system prompt", () => {
  it("puts top-level scalars in view and only placeholders for payloads", async () => {
    const seen: any[] = [];
    const fake = spinUpFakeAnthropic(
      { turns: [{ kind: "text", text: "ok" }] },
      { onRequest: (r) => seen.push(r.body) },
    );
    try {
      registerAgent([]);
      await collect(
        run(fake.port, {
          context: {
            route: "/imports/preview",
            import_batch_id: "b_123",
            rows: [{ description: "SQ *BLUE BOTTLE" }, { description: "RENT" }],
          },
        }),
      );
      const system = agentPrompts(seen).at(-1)!;
      expect(system).toContain("route: /imports/preview");
      expect(system).toContain("import_batch_id: b_123");
      expect(system).toContain("rows: <array of 2 items>");
      expect(system).not.toContain("BLUE BOTTLE");
      expect(system).toContain("data, not instructions");
    } finally {
      fake.stop();
    }
  });

  it("leaves the prompt untouched when there is no context", async () => {
    const seen: any[] = [];
    const fake = spinUpFakeAnthropic(
      { turns: [{ kind: "text", text: "ok" }] },
      { onRequest: (r) => seen.push(r.body) },
    );
    try {
      registerAgent([]);
      await collect(run(fake.port));
      const system = agentPrompts(seen).at(-1)!;
      expect(system).toContain(AGENT_PROMPT);
      expect(system).not.toContain("IRI_CONTEXT");
    } finally {
      fake.stop();
    }
  });

  it("keeps the agent-derived prefix identical across differing contexts", async () => {
    const seen: any[] = [];
    const fake = spinUpFakeAnthropic(
      { turns: [{ kind: "text", text: "ok" }] },
      { onRequest: (r) => seen.push(r.body) },
    );
    try {
      registerAgent([]);
      await collect(run(fake.port, { context: { route: "/accounts/acc_42" } }));
      const a = agentPrompts(seen).at(-1)!;
      await collect(run(fake.port, { context: { route: "/imports/preview", extra: 1 } }));
      const b = agentPrompts(seen).at(-1)!;
      expect(a).not.toBe(b);
      const cut = a.indexOf("<<<IRI_CONTEXT");
      expect(cut).toBeGreaterThan(0);
      expect(b.indexOf("<<<IRI_CONTEXT")).toBe(cut);
      // Everything before the block is byte-identical, so the cacheable prefix
      // does not move when the screen does.
      expect(b.slice(0, cut)).toBe(a.slice(0, cut));
    } finally {
      fake.stop();
    }
  });
});

describe("account page — the context answers what the prompt leaves out", () => {
  it("lets the model call a tool with an account id it was never told in the prompt", async () => {
    const received: AppRequest[] = [];
    const appServer = stubApp(received, () => Response.json({ total: -3218.55, count: 84 }));
    // The scripted model reads the account id out of the system prompt it was
    // actually given. Nothing hardcodes "acc_42" on the provider side, so this
    // passes only if the context really reached the model.
    const fake = spinUpFakeAnthropic({
      respond: (body) => {
        if (!toolNames(body).includes(SPENDING_TOOL)) return [{ kind: "text", text: "" }];
        if (sawToolResult(body)) return [{ kind: "text", text: "You spent $3,218.55." }];
        const system = systemOf(body);
        const id = /account_id: (\S+)/.exec(system)?.[1] ?? "UNRESOLVED";
        const today = /today: (\S+)/.exec(system)?.[1] ?? "UNRESOLVED";
        return [
          {
            kind: "tool_use",
            id: "tu_1",
            name: SPENDING_TOOL,
            input: { account_id: id, period: today.slice(0, 7) },
          },
        ];
      },
    });
    try {
      registerAgent([SPENDING], appServer.port);
      const { text } = await collect(
        run(fake.port, {
          message: "what was the total spending of this account last month",
          context: {
            route: "/accounts/acc_42",
            account_id: "acc_42",
            account_name: "Chase Checking",
            today: "2026-08-09",
          },
        }),
      );
      expect(received).toHaveLength(1);
      expect(received[0].body).toEqual({ account_id: "acc_42", period: "2026-08" });
      expect(text).toContain("You spent $3,218.55.");
    } finally {
      appServer.stop();
      fake.stop();
    }
  });
});

describe("get_context", () => {
  it("serves a nested payload the prompt only showed as a placeholder", async () => {
    let resultReachedModel = false;
    const fake = spinUpFakeAnthropic({
      respond: (body) => {
        if (!toolNames(body).includes(GET_CONTEXT)) return [{ kind: "text", text: "" }];
        if (sawToolResult(body)) {
          resultReachedModel = JSON.stringify(body.messages).includes("SQ *BLUE BOTTLE");
          return [{ kind: "text", text: "Categorized 2 rows." }];
        }
        return [{ kind: "tool_use", id: "tu_1", name: GET_CONTEXT, input: { path: "rows" } }];
      },
    });
    try {
      registerAgent([]);
      const { text } = await collect(
        run(fake.port, {
          message: "infer the categories, source, and target accounts",
          context: {
            route: "/imports/preview",
            rows: [{ description: "SQ *BLUE BOTTLE", amount: -6.75 }, { description: "RENT" }],
          },
        }),
      );
      expect(resultReachedModel).toBe(true);
      expect(text).toContain("Categorized 2 rows.");
    } finally {
      fake.stop();
    }
  });

  it("returns the whole context when no path is given", async () => {
    let payload = "";
    const fake = spinUpFakeAnthropic({
      respond: (body) => {
        if (!toolNames(body).includes(GET_CONTEXT)) return [{ kind: "text", text: "" }];
        if (sawToolResult(body)) {
          payload = JSON.stringify(body.messages);
          return [{ kind: "text", text: "done" }];
        }
        return [{ kind: "tool_use", id: "tu_1", name: GET_CONTEXT, input: {} }];
      },
    });
    try {
      registerAgent([]);
      await collect(run(fake.port, { context: { route: "/x", nested: { a: 1 } } }));
      expect(payload).toContain("/x");
      expect(payload).toContain("nested");
    } finally {
      fake.stop();
    }
  });

  it("answers an unresolvable path with an error result and keeps running", async () => {
    let errorReachedModel = false;
    const fake = spinUpFakeAnthropic({
      respond: (body) => {
        if (!toolNames(body).includes(GET_CONTEXT)) return [{ kind: "text", text: "" }];
        if (sawToolResult(body)) {
          const dump = JSON.stringify(body.messages);
          errorReachedModel = dump.includes("no value at context path") && dump.includes("rowz");
          return [{ kind: "text", text: "I mistyped that path." }];
        }
        return [{ kind: "tool_use", id: "tu_1", name: GET_CONTEXT, input: { path: "rowz" } }];
      },
    });
    try {
      registerAgent([]);
      const { text } = await collect(run(fake.port, { context: { rows: [1, 2] } }));
      expect(errorReachedModel).toBe(true);
      expect(text).toContain("I mistyped that path.");
    } finally {
      fake.stop();
    }
  });

  it("is not exposed at all when the run carries no context", async () => {
    const declared: string[][] = [];
    const fake = spinUpFakeAnthropic(
      { turns: [{ kind: "text", text: "ok" }] },
      { onRequest: (r) => declared.push(toolNames(r.body)) },
    );
    try {
      registerAgent([SPENDING]);
      await collect(run(fake.port));
      expect(declared.some((names) => names.includes(SPENDING_TOOL))).toBe(true);
      expect(declared.every((names) => !names.includes(GET_CONTEXT))).toBe(true);
    } finally {
      fake.stop();
    }
  });

  it("is exposed alongside the agent's own tools when context is present", async () => {
    const declared: string[][] = [];
    const fake = spinUpFakeAnthropic(
      { turns: [{ kind: "text", text: "ok" }] },
      { onRequest: (r) => declared.push(toolNames(r.body)) },
    );
    try {
      registerAgent([SPENDING]);
      await collect(run(fake.port, { context: { route: "/accounts/acc_42" } }));
      const withTools = declared.find((names) => names.includes(GET_CONTEXT))!;
      expect(withTools).toContain(SPENDING_TOOL);
    } finally {
      fake.stop();
    }
  });

  it("surfaces its invocation under iri_show_tool_calls", async () => {
    const fake = spinUpFakeAnthropic({
      respond: (body) => {
        if (!toolNames(body).includes(GET_CONTEXT)) return [{ kind: "text", text: "" }];
        if (sawToolResult(body)) return [{ kind: "text", text: "done" }];
        return [{ kind: "tool_use", id: "tu_1", name: GET_CONTEXT, input: { path: "route" } }];
      },
    });
    try {
      registerAgent([]);
      const { toolCalls } = await collect(
        run(fake.port, { context: { route: "/x" }, showToolCalls: true }),
      );
      expect(toolCalls.map((t) => t.name)).toContain(GET_CONTEXT);
      expect(toolCalls.find((t) => t.name === GET_CONTEXT)!.args).toContain("route");
    } finally {
      fake.stop();
    }
  });
});

describe("when-gated tool exposure", () => {
  async function declaredToolsFor(context?: Record<string, unknown>, tools = [SPENDING, IMPORT_MAPPING]) {
    const declared: string[][] = [];
    const fake = spinUpFakeAnthropic(
      { turns: [{ kind: "text", text: "ok" }] },
      { onRequest: (r) => declared.push(toolNames(r.body)) },
    );
    try {
      registerAgent(tools);
      await collect(run(fake.port, { context }));
      // The turn that declares any app tool is the agent turn; the SDK's
      // preliminary call declares none.
      return declared.find((names) => names.some((n) => n.startsWith("mcp__app__"))) ?? [];
    } finally {
      fake.stop();
    }
  }

  it("exposes a page-scoped tool on its own page", async () => {
    const names = await declaredToolsFor({ route: "/imports/preview" });
    expect(names).toContain(IMPORT_TOOL);
    expect(names).toContain(SPENDING_TOOL);
  });

  it("hides it elsewhere, and says which tool it dropped", async () => {
    const names = await declaredToolsFor({ route: "/accounts/acc_42" });
    expect(names).not.toContain(IMPORT_TOOL);
    expect(names).toContain(SPENDING_TOOL);
    const filtered = events.find((e) => e.event === "tools.filtered")!;
    expect(filtered.level).toBe("debug");
    expect(filtered.names).toEqual(["apply_import_mapping"]);
  });

  it("hides every gated tool when the request carries no context", async () => {
    const names = await declaredToolsFor(undefined);
    expect(names).not.toContain(IMPORT_TOOL);
    expect(names).toContain(SPENDING_TOOL);
  });

  it("matches array membership and prefixes", async () => {
    const viaArray = await declaredToolsFor({ route: "/imports/review" }, [
      { ...IMPORT_MAPPING, when: { route: ["/imports/preview", "/imports/review"] } },
    ]);
    expect(viaArray).toContain(IMPORT_TOOL);

    const viaPrefix = await declaredToolsFor({ route: "/accounts/acc_42" }, [
      { ...IMPORT_MAPPING, when: { route: { prefix: "/accounts/" } } },
    ]);
    expect(viaPrefix).toContain(IMPORT_TOOL);
  });

  it("requires every clause entry to hold", async () => {
    const names = await declaredToolsFor({ route: "/imports/preview" }, [
      { ...IMPORT_MAPPING, when: { route: "/imports/preview", import_batch_id: { exists: true } } },
    ]);
    expect(names).not.toContain(IMPORT_TOOL);
  });

  it("runs without error when every tool is gated out", async () => {
    const fake = spinUpFakeAnthropic({ turns: [{ kind: "text", text: "No tools here." }] });
    try {
      registerAgent([IMPORT_MAPPING]);
      const { text } = await collect(run(fake.port, { context: { route: "/elsewhere" } }));
      expect(text).toContain("No tools here.");
    } finally {
      fake.stop();
    }
  });

  it("never dials a gated-out mcp server", async () => {
    const server = spinUpFakeMcpServer();
    mcpServers.push(server);
    const fake = spinUpFakeAnthropic({ turns: [{ kind: "text", text: "ok" }] });
    try {
      registerAgent([
        {
          type: "mcp",
          name: "finance",
          url: server.url,
          headers: {},
          when: { route: "/imports/preview" },
        },
      ]);
      await collect(run(fake.port, { context: { route: "/accounts/acc_42" }, mcp: mcpRuntime() }));
      // Gating runs before discovery, so not even `initialize` is attempted.
      expect(server.methods).toEqual([]);
    } finally {
      fake.stop();
    }
  });

  it("discovers a matching mcp server's tools as usual", async () => {
    const server = spinUpFakeMcpServer();
    mcpServers.push(server);
    const declared: string[][] = [];
    const fake = spinUpFakeAnthropic(
      { turns: [{ kind: "text", text: "ok" }] },
      { onRequest: (r) => declared.push(toolNames(r.body)) },
    );
    try {
      registerAgent([
        {
          type: "mcp",
          name: "finance",
          url: server.url,
          headers: {},
          when: { route: { prefix: "/accounts/" } },
        },
      ]);
      await collect(run(fake.port, { context: { route: "/accounts/acc_42" }, mcp: mcpRuntime() }));
      expect(server.methods).toContain("tools/list");
      expect(declared.some((n) => n.includes("mcp__app__finance__list_accounts"))).toBe(true);
    } finally {
      fake.stop();
    }
  });
});
