import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildApp } from "../../src/server.ts";
import { createStore, type Store } from "../../src/registry/store.ts";
import { createLogger } from "../../src/logger.ts";
import { createMcpRuntime } from "../../src/agent/mcp/index.ts";
import { createMcpStatusTracker } from "../../src/internal/mcp-status.ts";
import { spinUpFakeMcpServer, type FakeMcpServer } from "../helpers/fake-mcp-server.ts";
import type { Config } from "../../src/config.ts";
import type { Manifest } from "../../src/registry/schema.ts";

/**
 * MCP connection health as the catalog reports it.
 *
 * The distinction these tests exist to protect is `unknown` vs `unreachable`.
 * Discovery is lazy and the tool cache records successes only, so without a
 * failure record both a never-contacted server and a dead one are "no cache
 * entry" — and telling an operator "we haven't looked" when the answer is
 * "it's down" is the exact failure this view was built to prevent.
 */

let store: Store;
let mcpServer: FakeMcpServer;

const cfg = (over: Partial<Config> = {}): Config => ({
  port: 0,
  maxAgentTurns: 20,
  toolCallTimeoutMs: 1000,
  manifestCacheTtlMs: 300000,
  requestTimeoutMs: 300000,
  mcpCacheTtlMs: 300000,
  maxContextBytes: 65536,
  mcpAllowedOrigins: [],
  uiEnabled: true,
  uiDist: "./ui/dist",
  dbPath: ":memory:",
  tmpDir: "/tmp/iri-test",
  providers: {
    anthropic: {
      name: "anthropic",
      apiKey: "k",
      baseUrl: "http://localhost:1",
      defaultModel: "claude-default",
      authStyle: "api_key",
    },
  },
  defaultProvider: "anthropic",
  apiKey: "client-key",
  registrationSecret: "reg",
  ...over,
});

/** Two agents sharing one connection, plus one pointing at a dead port. */
function manifestFor(liveUrl: string, deadUrl: string): Manifest {
  return {
    manifest_version: "1",
    app: { id: "finance-app", name: "Finance App", description: "money" },
    agents: [
      {
        id: "ledger-bot",
        name: "Ledger",
        description: "books",
        system_prompt: "p",
        tools: [{ type: "mcp", name: "finance", url: liveUrl, headers: {} }],
        skills: [],
      },
      {
        id: "audit-bot",
        name: "Audit",
        description: "audit",
        system_prompt: "p",
        tools: [
          // Same URL and headers as ledger-bot: one connection, one cache
          // entry, and so one row in the status view.
          { type: "mcp", name: "finance", url: liveUrl, headers: {} },
          { type: "mcp", name: "archive", url: deadUrl, headers: {} },
        ],
        skills: [],
      },
    ],
  } as Manifest;
}

const silent = () => createLogger({ sink: () => {} });

function harness(config = cfg()) {
  const logger = silent();
  const mcp = createMcpRuntime({ config, logger });
  const tracker = createMcpStatusTracker();
  mcp.onDiscoveryFailure = (entry, reason) => tracker.recordFailure(entry, reason);
  const app = buildApp({ config, store, logger, mcp, tracker });
  return { app, mcp, tracker };
}

const DEAD_URL = "http://127.0.0.1:1/mcp";

beforeEach(() => {
  store = createStore({ dbPath: ":memory:" });
  mcpServer = spinUpFakeMcpServer({
    tools: [
      { name: "list_accounts", description: "accounts" },
      { name: "get_transaction", description: "one transaction" },
    ],
  });
  store.upsertApp({
    id: "finance-app",
    base_url: "http://localhost:4002",
    app_token: "tok",
    manifest: manifestFor(`http://localhost:${mcpServer.port}/mcp`, DEAD_URL),
  });
});
afterEach(async () => {
  store.close();
  await mcpServer.stop();
});

async function statuses(app: ReturnType<typeof harness>["app"]) {
  const res = await app.fetch(new Request("http://x/internal/mcp/servers"));
  expect(res.status).toBe(200);
  return ((await res.json()) as any).servers as any[];
}

describe("GET /internal/mcp/servers", () => {
  it("reads a never-contacted server as unknown, with no discovery time", async () => {
    const { app } = harness();
    const rows = await statuses(app);
    for (const row of rows) {
      expect(row.status).toBe("unknown");
      expect(row.discovered_at).toBeNull();
      expect(row.tool_count).toBeNull();
    }
  });

  it("reports one entry per connection, naming every agent that declares it", async () => {
    const { app } = harness();
    const rows = await statuses(app);
    // Three declarations across two agents, but only two distinct connections.
    expect(rows).toHaveLength(2);
    const live = rows.find((r) => r.url.includes(String(mcpServer.port)));
    expect(live.agents.sort()).toEqual(["audit-bot", "ledger-bot"]);
  });

  it("performs no network I/O, so dead servers do not delay the read", async () => {
    const { app } = harness();
    await statuses(app);
    // The fake server records every JSON-RPC method it receives. A status read
    // that dialed out would show at least an `initialize`.
    expect(mcpServer.methods).toEqual([]);
  });

  it("reads a fresh cache as ok and an expired one as stale, keeping the tool count", async () => {
    const { app, mcp } = harness();
    const entry = { url: `http://localhost:${mcpServer.port}/mcp`, headers: {} };

    mcp.cache.set(entry, [
      { name: "list_accounts", description: "d", inputSchema: {} },
      { name: "get_transaction", description: "d", inputSchema: {} },
    ]);

    let live = (await statuses(app)).find((r) => r.url.includes(String(mcpServer.port)));
    expect(live.status).toBe("ok");
    expect(live.tool_count).toBe(2);
    expect(typeof live.discovered_at).toBe("number");

    // Age the entry past the TTL without touching the clock.
    mcp.cache.set(entry, [
      { name: "list_accounts", description: "d", inputSchema: {} },
      { name: "get_transaction", description: "d", inputSchema: {} },
    ], Date.now() - 400000);

    live = (await statuses(app)).find((r) => r.url.includes(String(mcpServer.port)));
    expect(live.status).toBe("stale");
    // A stale list is still the last thing known to be true about the server.
    expect(live.tool_count).toBe(2);
  });

  it("distinguishes unknown from unreachable once an attempt has failed", async () => {
    const { app, tracker } = harness();
    tracker.recordFailure({ url: DEAD_URL, headers: {} }, "connect ECONNREFUSED 127.0.0.1:1");

    const rows = await statuses(app);
    const dead = rows.find((r) => r.url === DEAD_URL);
    const live = rows.find((r) => r.url.includes(String(mcpServer.port)));

    expect(dead.status).toBe("unreachable");
    expect(dead.error).toMatch(/ECONNREFUSED/);
    expect(typeof dead.error_at).toBe("number");

    expect(live.status).toBe("unknown");
    expect(live.error).toBeNull();
  });

  it("lets a later success supersede an earlier failure", async () => {
    const { app, mcp, tracker } = harness();
    const entry = { url: `http://localhost:${mcpServer.port}/mcp`, headers: {} };
    tracker.recordFailure(entry, "was down", Date.now() - 1000);
    mcp.cache.set(entry, [{ name: "list_accounts", description: "d", inputSchema: {} }]);

    const live = (await statuses(app)).find((r) => r.url.includes(String(mcpServer.port)));
    // The two records are ordered by time rather than one being preferred, so
    // a recovered server stops reading as broken without anyone clearing it.
    expect(live.status).toBe("ok");
  });
});

describe("POST /internal/agents/:agentId/mcp/:serverName/probe", () => {
  it("reports the discovered tools and warms the cache", async () => {
    const { app } = harness();
    const res = await app.fetch(
      new Request("http://x/internal/agents/ledger-bot/mcp/finance/probe", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("ok");
    expect(body.tool_count).toBe(2);
    expect(body.tools.sort()).toEqual(["get_transaction", "list_accounts"]);

    const live = (await statuses(app)).find((r) => r.url.includes(String(mcpServer.port)));
    expect(live.status).toBe("ok");
    expect(live.tool_count).toBe(2);
  });

  it("dials out even when a fresh cache entry exists", async () => {
    const { app, mcp } = harness();
    mcp.cache.set(
      { url: `http://localhost:${mcpServer.port}/mcp`, headers: {} },
      [{ name: "stale_tool", description: "d", inputSchema: {} }],
    );
    await app.fetch(
      new Request("http://x/internal/agents/ledger-bot/mcp/finance/probe", { method: "POST" }),
    );
    // A probe served from cache would be a no-op exactly when someone is
    // pressing it to find out whether the server came back.
    expect(mcpServer.countOf("tools/list")).toBe(1);
  });

  it("reports a failure as an outcome, not an error status", async () => {
    const { app } = harness();
    const res = await app.fetch(
      new Request("http://x/internal/agents/audit-bot/mcp/archive/probe", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("unreachable");
    expect(body.error).toBeTruthy();

    const dead = (await statuses(app)).find((r) => r.url === DEAD_URL);
    expect(dead.status).toBe("unreachable");
    expect(dead.error).toBe(body.error);
  });

  it("404s a server the agent does not declare, making no outbound request", async () => {
    const { app } = harness();
    const res = await app.fetch(
      new Request("http://x/internal/agents/ledger-bot/mcp/archive/probe", { method: "POST" }),
    );
    expect(res.status).toBe(404);
    expect(mcpServer.methods).toEqual([]);
  });

  it("404s an unknown agent", async () => {
    const { app } = harness();
    const res = await app.fetch(
      new Request("http://x/internal/agents/nope/mcp/finance/probe", { method: "POST" }),
    );
    expect(res.status).toBe(404);
  });

  it("refuses a declared server whose origin is not allowlisted", async () => {
    const { app } = harness(
      cfg({ mcpAllowedOrigins: ["http://example.invalid"] }),
    );
    const res = await app.fetch(
      new Request("http://x/internal/agents/ledger-bot/mcp/finance/probe", { method: "POST" }),
    );
    const body = (await res.json()) as any;
    expect(body.status).toBe("unreachable");
    expect(body.error).toMatch(/IRI_MCP_ALLOWED_ORIGINS/);
    expect(mcpServer.methods).toEqual([]);
  });
});
