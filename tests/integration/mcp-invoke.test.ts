import { describe, it, expect, afterEach } from "vitest";
import { invokeTool } from "../../src/agent/tools.ts";
import { createMcpRuntime } from "../../src/agent/mcp/index.ts";
import type { McpRuntime } from "../../src/agent/mcp/discovery.ts";
import type { McpServerTool } from "../../src/registry/schema.ts";
import { createLogger } from "../../src/logger.ts";
import { spinUpFakeMcpServer, unreachableMcpUrl, type FakeMcpServer } from "../helpers/fake-mcp-server.ts";

/**
 * MCP errors are folded into the contract `invokeApiCallTool` already
 * produces rather than a parallel one. These assert the exact shapes, because
 * "the model got told something went wrong" is not the requirement — the
 * requirement is that a transport failure is indistinguishable from an
 * `api_call` transport failure.
 */

const runtimes: McpRuntime[] = [];
const servers: FakeMcpServer[] = [];

function runtime(overrides: Partial<Pick<McpRuntime, "allowedOrigins" | "cacheTtlMs">> = {}) {
  const rt = createMcpRuntime({
    config: {
      mcpCacheTtlMs: overrides.cacheTtlMs ?? 300_000,
      mcpAllowedOrigins: overrides.allowedOrigins ?? [],
    },
    logger: createLogger({ sink: () => {} }),
  });
  runtimes.push(rt);
  return rt;
}

function server(opts: Parameters<typeof spinUpFakeMcpServer>[0] = {}) {
  const s = spinUpFakeMcpServer(opts);
  servers.push(s);
  return s;
}

function entry(url: string, overrides: Partial<McpServerTool> = {}): McpServerTool {
  return { type: "mcp", name: "finance", url, headers: {}, ...overrides } as McpServerTool;
}

async function call(
  rt: McpRuntime,
  e: McpServerTool,
  toolName: string,
  input: Record<string, unknown> = {},
) {
  return invokeTool({
    tool: e,
    toolName,
    input,
    defaultTimeoutMs: 5_000,
    mcp: rt,
  });
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((rt) => rt.pool.closeAll()));
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

describe("invokeMcpTool — success", () => {
  it("returns JSON content parsed, not as a JSON-encoded string", async () => {
    const s = server({
      tools: [{ name: "list_accounts" }],
      behaviors: { list_accounts: { kind: "json", data: { accounts: [{ id: 21 }] } } },
    });
    const result = await call(runtime(), entry(s.url), "list_accounts");
    expect(result).toEqual({ accounts: [{ id: 21 }] });
  });

  it("returns non-JSON text content as a raw string", async () => {
    const s = server({
      tools: [{ name: "note" }],
      behaviors: { note: { kind: "text", text: "just words" } },
    });
    expect(await call(runtime(), entry(s.url), "note")).toBe("just words");
  });

  it("passes the model's arguments through to the server", async () => {
    const s = server({ tools: [{ name: "get_transaction" }] });
    await call(runtime(), entry(s.url), "get_transaction", { id: 42 });
    expect(s.calls).toEqual([{ name: "get_transaction", arguments: { id: 42 } }]);
  });

  it("calls the server by the tool's own name, not the prefixed one", async () => {
    const s = server({ tools: [{ name: "list_accounts" }] });
    await call(runtime(), entry(s.url), "list_accounts");
    expect(s.calls[0].name).toBe("list_accounts");
  });
});

describe("invokeMcpTool — error mapping", () => {
  it("maps connection refused to the api_call network shape", async () => {
    const url = await unreachableMcpUrl();
    const result = (await call(runtime(), entry(url), "list_accounts")) as any;
    expect(result.error.kind).toBe("network");
    expect(typeof result.error.message).toBe("string");
    expect(result.error).not.toHaveProperty("status");
  });

  it("maps a timeout to the api_call timeout shape", async () => {
    const s = server({
      tools: [{ name: "slow" }],
      behaviors: { slow: { kind: "hang" } },
    });
    const result = (await invokeTool({
      tool: entry(s.url, { timeout_ms: 150 }),
      toolName: "slow",
      input: {},
      defaultTimeoutMs: 5_000,
      mcp: runtime(),
    })) as any;
    expect(result.error.kind).toBe("timeout");
    expect(result.error.message).toMatch(/150ms/);
  });

  it("maps a non-2xx response to the api_call { status, body } shape", async () => {
    const s = server({
      tools: [{ name: "broken" }],
      behaviors: { broken: { kind: "http_error", status: 503, body: "upstream down" } },
    });
    const result = (await call(runtime(), entry(s.url), "broken")) as any;
    expect(result.error).toHaveProperty("status", 503);
    expect(result.error).not.toHaveProperty("kind");
  });

  it("maps a JSON-RPC error to mcp_protocol, carrying the server's code", async () => {
    const s = server({
      tools: [{ name: "refused" }],
      behaviors: { refused: { kind: "jsonrpc_error", code: -32601, message: "Method not found" } },
    });
    const result = (await call(runtime(), entry(s.url), "refused")) as any;
    expect(result.error.kind).toBe("mcp_protocol");
    expect(result.error.code).toBe(-32601);
    expect(result.error.message).toMatch(/Method not found/);
  });

  it("maps isError to mcp_tool_error, preserving the server's text verbatim", async () => {
    // The finance-mcp cold-Neon-pool case: the model must see the real message
    // to be able to decide to retry.
    const s = server({
      tools: [{ name: "list_accounts" }],
      behaviors: {
        list_accounts: { kind: "tool_error", text: "Failed query: select * from accounts" },
      },
    });
    const result = (await call(runtime(), entry(s.url), "list_accounts")) as any;
    expect(result.error.kind).toBe("mcp_tool_error");
    expect(result.error.message).toBe("Failed query: select * from accounts");
  });

  it("refuses to connect to a disallowed origin at call time", async () => {
    const s = server({ tools: [{ name: "list_accounts" }] });
    const rt = runtime({ allowedOrigins: ["http://allowed.example"] });
    // Discovery is what enforces the allowlist; a call still must not silently
    // succeed against a server the operator has excluded.
    const tools = await import("../../src/agent/mcp/discovery.ts").then((m) =>
      m.discoverTools(entry(s.url), rt),
    );
    expect(tools).toEqual([]);
    expect(s.countOf("tools/list")).toBe(0);
  });
});

describe("invokeMcpTool — retry policy", () => {
  it("retries once on transport failure and succeeds on the second attempt", async () => {
    const s = server({
      tools: [{ name: "flaky" }],
      behaviors: { flaky: { kind: "http_error", status: 503 } },
    });
    const rt = runtime();
    // Repair the server between the two attempts.
    setTimeout(() => s.setBehavior("flaky", { kind: "json", data: { ok: true } }), 100);
    const result = await call(rt, entry(s.url), "flaky");
    expect(result).toEqual({ ok: true });
    expect(s.calls.length).toBe(2);
  });

  it("does not retry an isError result", async () => {
    const s = server({
      tools: [{ name: "list_accounts" }],
      behaviors: { list_accounts: { kind: "tool_error", text: "boom" } },
    });
    const result = (await call(runtime(), entry(s.url), "list_accounts")) as any;
    expect(result.error.kind).toBe("mcp_tool_error");
    expect(s.calls.length).toBe(1);
  });
});

describe("invokeTool — dispatch", () => {
  it("throws when an mcp tool is invoked without a runtime", async () => {
    await expect(
      invokeTool({
        tool: entry("http://example.com/mcp"),
        toolName: "list_accounts",
        input: {},
        defaultTimeoutMs: 1000,
      }),
    ).rejects.toThrow(/mcp runtime/);
  });

  it("throws when an mcp tool is invoked without a resolved tool name", async () => {
    await expect(
      invokeTool({
        tool: entry("http://example.com/mcp"),
        input: {},
        defaultTimeoutMs: 1000,
        mcp: runtime(),
      }),
    ).rejects.toThrow(/resolved tool name/);
  });

  it("throws when an api_call tool is invoked without app credentials", async () => {
    await expect(
      invokeTool({
        tool: {
          type: "api_call",
          name: "get_forecast",
          description: "d",
          parameters: { type: "object", properties: {} },
          endpoint: { method: "POST", path: "/api/forecast" },
        },
        input: {},
        defaultTimeoutMs: 1000,
      }),
    ).rejects.toThrow(/base_url/);
  });
});
