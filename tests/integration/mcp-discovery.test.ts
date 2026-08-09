import { describe, it, expect, afterEach } from "vitest";
import { discoverTools, expandAgentTools } from "../../src/agent/mcp/discovery.ts";
import { refreshStaleMcpTools } from "../../src/agent/mcp/refresh.ts";
import { createMcpRuntime } from "../../src/agent/mcp/index.ts";
import type { McpRuntime } from "../../src/agent/mcp/discovery.ts";
import type { McpServerTool, Tool } from "../../src/registry/schema.ts";
import { createLogger, type LogEvent } from "../../src/logger.ts";
import { spinUpFakeMcpServer, unreachableMcpUrl, type FakeMcpServer } from "../helpers/fake-mcp-server.ts";

const runtimes: McpRuntime[] = [];
const servers: FakeMcpServer[] = [];

function runtime(
  overrides: { allowedOrigins?: string[]; cacheTtlMs?: number } = {},
): McpRuntime & { logs: LogEvent[] } {
  const logs: LogEvent[] = [];
  const rt = createMcpRuntime({
    config: {
      mcpCacheTtlMs: overrides.cacheTtlMs ?? 300_000,
      mcpAllowedOrigins: overrides.allowedOrigins ?? [],
    },
    logger: createLogger({ sink: (e) => logs.push(e) }),
  });
  runtimes.push(rt);
  return Object.assign(rt, { logs });
}

function server(opts: Parameters<typeof spinUpFakeMcpServer>[0] = {}) {
  const s = spinUpFakeMcpServer(opts);
  servers.push(s);
  return s;
}

function entry(url: string, overrides: Partial<McpServerTool> = {}): McpServerTool {
  return { type: "mcp", name: "finance", url, headers: {}, ...overrides } as McpServerTool;
}

const API_CALL_TOOL: Tool = {
  type: "api_call",
  name: "get_forecast",
  description: "d",
  parameters: { type: "object", properties: {} },
  endpoint: { method: "POST", path: "/api/forecast" },
};

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((rt) => rt.pool.closeAll()));
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

describe("discoverTools — caching", () => {
  it("lists once and serves the second call from cache", async () => {
    const s = server({ tools: [{ name: "list_accounts" }] });
    const rt = runtime();
    const e = entry(s.url);
    await discoverTools(e, rt);
    await discoverTools(e, rt);
    expect(s.countOf("tools/list")).toBe(1);
  });

  it("shares one list between two agents declaring the same url and headers", async () => {
    const s = server({ tools: [{ name: "list_accounts" }] });
    const rt = runtime();
    await discoverTools(entry(s.url, { name: "finance" }), rt);
    await discoverTools(entry(s.url, { name: "money" }), rt);
    expect(s.countOf("tools/list")).toBe(1);
  });

  it("treats differing headers as a separate connection", async () => {
    const s = server({ tools: [{ name: "list_accounts" }] });
    const rt = runtime();
    await discoverTools(entry(s.url, { headers: {} }), rt);
    await discoverTools(entry(s.url, { headers: { "X-Tenant": "b" } }), rt);
    expect(s.countOf("tools/list")).toBe(2);
  });

  it("re-lists once the entry passes its TTL", async () => {
    const s = server({ tools: [{ name: "list_accounts" }] });
    const rt = runtime({ cacheTtlMs: 50 });
    const e = entry(s.url);
    await discoverTools(e, rt);
    await new Promise((r) => setTimeout(r, 80));
    await discoverTools(e, rt);
    expect(s.countOf("tools/list")).toBe(2);
  });

  it("picks up a tool added to the server after re-discovery", async () => {
    const s = server({ tools: [{ name: "list_accounts" }] });
    const rt = runtime({ cacheTtlMs: 50 });
    const e = entry(s.url);
    expect((await discoverTools(e, rt)).map((t) => t.name)).toEqual(["list_accounts"]);
    s.setTools([{ name: "list_accounts" }, { name: "list_tags" }]);
    await new Promise((r) => setTimeout(r, 80));
    expect((await discoverTools(e, rt)).map((t) => t.name)).toEqual([
      "list_accounts",
      "list_tags",
    ]);
  });

  it("applies the entry's tools allowlist without narrowing the cache", async () => {
    const s = server({ tools: [{ name: "list_accounts" }, { name: "list_tags" }] });
    const rt = runtime();
    const narrowed = await discoverTools(entry(s.url, { tools: ["list_accounts"] }), rt);
    expect(narrowed.map((t) => t.name)).toEqual(["list_accounts"]);
    // A second agent on the same server, without an allowlist, still sees both.
    const full = await discoverTools(entry(s.url), rt);
    expect(full.map((t) => t.name)).toEqual(["list_accounts", "list_tags"]);
  });

  it("exposes nothing for an empty allowlist", async () => {
    const s = server({ tools: [{ name: "list_accounts" }] });
    expect(await discoverTools(entry(s.url, { tools: [] }), runtime())).toEqual([]);
  });
});

describe("discoverTools — failure handling", () => {
  it("returns no tools and warns when the server is unreachable", async () => {
    const rt = runtime();
    const tools = await discoverTools(entry(await unreachableMcpUrl()), rt);
    expect(tools).toEqual([]);
    const warn = rt.logs.find((l) => l.event === "mcp.discovery_failed");
    expect(warn?.level).toBe("warn");
    expect(warn?.server).toBe("finance");
  });

  it("returns no tools when tools/list answers a JSON-RPC error", async () => {
    const s = server({
      listBehavior: { kind: "jsonrpc_error", code: -32603, message: "internal" },
    });
    expect(await discoverTools(entry(s.url), runtime())).toEqual([]);
  });

  it("retains a previously discovered list when a re-list fails", async () => {
    // A server that flaps must not yank its tools away mid-conversation.
    const s = server({ tools: [{ name: "list_accounts" }] });
    const rt = runtime({ cacheTtlMs: 50 });
    const e = entry(s.url);
    await discoverTools(e, rt);
    await s.stop();
    await new Promise((r) => setTimeout(r, 80));
    expect((await discoverTools(e, rt)).map((t) => t.name)).toEqual(["list_accounts"]);
  });

  it("refuses a disallowed origin without contacting the server", async () => {
    const s = server({ tools: [{ name: "list_accounts" }] });
    const rt = runtime({ allowedOrigins: ["http://allowed.example"] });
    expect(await discoverTools(entry(s.url), rt)).toEqual([]);
    expect(s.methods).toEqual([]);
    expect(rt.logs.find((l) => l.event === "mcp.discovery_refused")?.reason).toBe(
      "origin_not_allowed",
    );
  });

  it("permits an origin that is on the allowlist", async () => {
    const s = server({ tools: [{ name: "list_accounts" }] });
    const rt = runtime({ allowedOrigins: [new URL(s.url).origin] });
    expect((await discoverTools(entry(s.url), rt)).map((t) => t.name)).toEqual([
      "list_accounts",
    ]);
  });
});

describe("expandAgentTools", () => {
  it("passes api_call entries through and fans mcp entries out", async () => {
    const s = server({ tools: [{ name: "list_accounts" }, { name: "list_tags" }] });
    const { apiCallTools, mcpTools } = await expandAgentTools(
      [API_CALL_TOOL, entry(s.url)],
      runtime(),
    );
    expect(apiCallTools.map((t) => t.name)).toEqual(["get_forecast"]);
    expect(mcpTools.map((t) => t.exposedName)).toEqual([
      "finance__list_accounts",
      "finance__list_tags",
    ]);
  });

  it("keeps the server's own name alongside the exposed one", async () => {
    const s = server({ tools: [{ name: "list_accounts" }] });
    const { mcpTools } = await expandAgentTools([entry(s.url)], runtime());
    expect(mcpTools[0]).toMatchObject({
      exposedName: "finance__list_accounts",
      toolName: "list_accounts",
    });
  });

  it("distinguishes the same tool name on two servers", async () => {
    const a = server({ tools: [{ name: "search" }] });
    const b = server({ tools: [{ name: "search" }] });
    const { mcpTools } = await expandAgentTools(
      [entry(a.url, { name: "finance" }), entry(b.url, { name: "docs" })],
      runtime(),
    );
    expect(mcpTools.map((t) => t.exposedName)).toEqual(["finance__search", "docs__search"]);
  });

  it("drops a discovered tool colliding with an api_call name, keeping the rest", async () => {
    const s = server({ tools: [{ name: "forecast" }, { name: "list_tags" }] });
    const collidingApiCall: Tool = { ...(API_CALL_TOOL as any), name: "finance__forecast" };
    const rt = runtime();
    const { mcpTools } = await expandAgentTools([collidingApiCall, entry(s.url)], rt);
    expect(mcpTools.map((t) => t.exposedName)).toEqual(["finance__list_tags"]);
    expect(rt.logs.find((l) => l.event === "mcp.tool_dropped")?.reason).toBe("collision");
  });

  it("drops a tool whose prefixed name exceeds the length limit", async () => {
    const s = server({ tools: [{ name: "a".repeat(60) }, { name: "ok" }] });
    const rt = runtime();
    const { mcpTools } = await expandAgentTools([entry(s.url)], rt);
    expect(mcpTools.map((t) => t.exposedName)).toEqual(["finance__ok"]);
    expect(rt.logs.find((l) => l.event === "mcp.tool_dropped")?.reason).toBe("too_long");
  });

  it("contributes nothing when an agent declares no mcp entries", async () => {
    const rt = runtime();
    const { apiCallTools, mcpTools } = await expandAgentTools([API_CALL_TOOL], rt);
    expect(apiCallTools.length).toBe(1);
    expect(mcpTools).toEqual([]);
  });

  it("leaves api_call tools intact when the mcp server is unreachable", async () => {
    const { apiCallTools, mcpTools } = await expandAgentTools(
      [API_CALL_TOOL, entry(await unreachableMcpUrl())],
      runtime(),
    );
    expect(apiCallTools.map((t) => t.name)).toEqual(["get_forecast"]);
    expect(mcpTools).toEqual([]);
  });
});

describe("refreshStaleMcpTools", () => {
  it("re-lists a stale entry with no run in flight", async () => {
    const s = server({ tools: [{ name: "list_accounts" }] });
    const rt = runtime({ cacheTtlMs: 50 });
    const e = entry(s.url);
    await discoverTools(e, rt);
    s.setTools([{ name: "list_accounts" }, { name: "list_tags" }]);
    await new Promise((r) => setTimeout(r, 80));

    await refreshStaleMcpTools(rt);
    expect(s.countOf("tools/list")).toBe(2);
    // Now fresh, so the next discovery is served from the refreshed cache.
    expect((await discoverTools(e, rt)).map((t) => t.name)).toEqual([
      "list_accounts",
      "list_tags",
    ]);
    expect(s.countOf("tools/list")).toBe(2);
  });

  it("leaves a fresh entry alone", async () => {
    const s = server({ tools: [{ name: "list_accounts" }] });
    const rt = runtime({ cacheTtlMs: 300_000 });
    await discoverTools(entry(s.url), rt);
    await refreshStaleMcpTools(rt);
    expect(s.countOf("tools/list")).toBe(1);
  });

  it("preserves the previous list and warns when a refresh fails", async () => {
    const s = server({ tools: [{ name: "list_accounts" }] });
    const rt = runtime({ cacheTtlMs: 50 });
    const e = entry(s.url);
    await discoverTools(e, rt);
    await s.stop();
    await new Promise((r) => setTimeout(r, 80));

    await refreshStaleMcpTools(rt);
    expect(rt.logs.find((l) => l.event === "mcp.refresh_failed")?.level).toBe("warn");
    expect(rt.cache.peek(e)?.tools.map((t) => t.name)).toEqual(["list_accounts"]);
  });

  it("drops an entry whose origin is no longer allowed", async () => {
    const s = server({ tools: [{ name: "list_accounts" }] });
    const rt = runtime({ cacheTtlMs: 50 });
    const e = entry(s.url);
    await discoverTools(e, rt);
    await new Promise((r) => setTimeout(r, 80));

    rt.allowedOrigins = ["http://allowed.example"];
    await refreshStaleMcpTools(rt);
    expect(rt.cache.peek(e)).toBeNull();
    expect(rt.logs.find((l) => l.event === "mcp.refresh_failed")?.reason).toBe(
      "origin_not_allowed",
    );
  });

  it("does not touch servers that were never discovered", async () => {
    const s = server({ tools: [{ name: "list_accounts" }] });
    await refreshStaleMcpTools(runtime({ cacheTtlMs: 0 }));
    expect(s.methods).toEqual([]);
  });
});
