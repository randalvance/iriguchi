import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildApp } from "../../src/server.ts";
import { createStore, type Store } from "../../src/registry/store.ts";
import { createLogger } from "../../src/logger.ts";
import type { Config } from "../../src/config.ts";
import type { Manifest } from "../../src/registry/schema.ts";

/**
 * The read-only half of the internal surface: the agent catalog, agent detail,
 * and the gate that decides whether any of it exists.
 *
 * The secrets sweep at the bottom is the load-bearing test in this file. Every
 * other assertion here would still pass if a handler returned the stored app
 * record wholesale — and that record carries the app token, on an endpoint
 * that takes no credential.
 */

const APP_TOKEN_A = "tok-app-a-SECRET";
const APP_TOKEN_B = "tok-app-b-SECRET";
const MCP_HEADER_VALUE = "Bearer mcp-secret-value";

let store: Store;

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
      apiKey: "prov-key-anthropic-SECRET",
      baseUrl: "http://localhost:1",
      defaultModel: "claude-default",
      authStyle: "api_key",
    },
    openrouter: {
      name: "openrouter",
      apiKey: "prov-key-openrouter-SECRET",
      baseUrl: "http://localhost:2",
      defaultModel: "moonshotai/kimi-k3",
      authStyle: "auth_token",
    },
  },
  defaultProvider: "anthropic",
  apiKey: "client-key",
  registrationSecret: "reg",
  ...over,
});

const manifestA: Manifest = {
  manifest_version: "1",
  app: { id: "weather-app", name: "Weather App", description: "weather" },
  agents: [
    {
      id: "weather-bot",
      name: "Weather Bot",
      description: "Forecasts",
      system_prompt: "You are a weather bot.",
      // No provider, no default_model: must be reported as resolved, not blank.
      tools: [
        {
          type: "api_call",
          name: "get_forecast",
          description: "Fetch a forecast",
          parameters: { type: "object", properties: { city: { type: "string" } } },
          endpoint: { method: "POST", path: "/api/forecast" },
        },
        {
          type: "mcp",
          name: "finance",
          url: "http://localhost:9/mcp",
          headers: { Authorization: MCP_HEADER_VALUE },
        },
      ],
      skills: [{ name: "jargon", content: "some skill body" }],
    },
    {
      id: "radar-bot",
      name: "Radar Bot",
      description: "Radar",
      system_prompt: "You are radar.",
      provider: "openrouter",
      default_model: "moonshotai/kimi-k3",
      tools: [],
      skills: [],
    },
  ],
} as Manifest;

const manifestB: Manifest = {
  manifest_version: "1",
  app: { id: "finance-app", name: "Finance App", description: "money" },
  agents: [
    {
      id: "ledger-bot",
      name: "Ledger Bot",
      description: "Books",
      system_prompt: "You are a ledger.",
      tools: [],
      skills: [],
    },
  ],
} as Manifest;

beforeEach(() => {
  store = createStore({ dbPath: ":memory:" });
  store.upsertApp({
    id: "weather-app",
    base_url: "http://localhost:4001",
    app_token: APP_TOKEN_A,
    manifest: manifestA,
  });
  store.upsertApp({
    id: "finance-app",
    base_url: "http://localhost:4002",
    app_token: APP_TOKEN_B,
    manifest: manifestB,
  });
});
afterEach(() => store.close());

const silent = () => createLogger({ sink: () => {} });

function app(config = cfg()) {
  return buildApp({ config, store, logger: silent() });
}

describe("internal surface gate", () => {
  it("is absent when IRI_UI_ENABLED is unset", async () => {
    const gw = app(cfg({ uiEnabled: false }));
    expect((await gw.fetch(new Request("http://x/internal/agents"))).status).toBe(404);
    expect((await gw.fetch(new Request("http://x/internal/mcp/servers"))).status).toBe(404);
    expect((await gw.fetch(new Request("http://x/ui"))).status).toBe(404);
    expect((await gw.fetch(new Request("http://x/ui/index.html"))).status).toBe(404);
  });

  it("serves the catalog with no Authorization header when enabled", async () => {
    const res = await app().fetch(new Request("http://x/internal/agents"));
    expect(res.status).toBe(200);
  });

  it("does not relax the public surfaces when enabled", async () => {
    const gw = app();
    expect((await gw.fetch(new Request("http://x/v1/models"))).status).toBe(401);
    const chat = await gw.fetch(
      new Request("http://x/v1/chat/completions", { method: "POST", body: "{}" }),
    );
    expect(chat.status).toBe(401);
  });

  it("diagnoses a missing UI build instead of a bare 404", async () => {
    const gw = app(cfg({ uiDist: "./ui/dist-does-not-exist" }));
    const res = await gw.fetch(new Request("http://x/ui/"));
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).toMatch(/not built/);
    expect(text).toMatch(/npm run ui:build/);
  });

  it("warns at startup, naming the exposure", () => {
    const events: any[] = [];
    buildApp({
      config: cfg(),
      store,
      logger: createLogger({ sink: (e) => events.push(e) }),
    });
    const warn = events.find((e) => e.event === "ui.enabled");
    expect(warn).toBeDefined();
    expect(warn.level).toBe("warn");
    expect(String(warn.message)).toMatch(/UNAUTHENTICATED/);
  });
});

describe("GET /internal/agents", () => {
  it("flattens every agent across apps, naming each owner", async () => {
    const res = await app().fetch(new Request("http://x/internal/agents"));
    const body = (await res.json()) as any;
    expect(body.agents).toHaveLength(3);
    const byId = Object.fromEntries(body.agents.map((a: any) => [a.id, a]));
    expect(Object.keys(byId).sort()).toEqual(["ledger-bot", "radar-bot", "weather-bot"]);
    expect(byId["weather-bot"].app_id).toBe("weather-app");
    expect(byId["ledger-bot"].app_id).toBe("finance-app");
  });

  it("reports inherited provider and model as resolved, not blank", async () => {
    const res = await app().fetch(new Request("http://x/internal/agents"));
    const body = (await res.json()) as any;
    const inherited = body.agents.find((a: any) => a.id === "weather-bot");
    expect(inherited.provider).toBe("anthropic");
    expect(inherited.model).toBe("claude-default");

    const explicit = body.agents.find((a: any) => a.id === "radar-bot");
    expect(explicit.provider).toBe("openrouter");
    expect(explicit.model).toBe("moonshotai/kimi-k3");
  });

  it("counts api_call tools, mcp servers, and skills separately", async () => {
    const res = await app().fetch(new Request("http://x/internal/agents"));
    const body = (await res.json()) as any;
    const bot = body.agents.find((a: any) => a.id === "weather-bot");
    expect(bot.api_call_tool_count).toBe(1);
    expect(bot.mcp_server_count).toBe(1);
    expect(bot.skill_count).toBe(1);
  });

  it("contributes nothing for an app with no fetched manifest, and still succeeds", async () => {
    // Registered but never fetched: the store row exists with a null manifest.
    const bare = createStore({ dbPath: ":memory:" });
    bare.upsertApp({
      id: "weather-app",
      base_url: "http://localhost:4001",
      app_token: APP_TOKEN_A,
      manifest: manifestA,
    });
    const rows = bare.listApps();
    expect(rows).toHaveLength(1);
    bare.close();

    const empty = createStore({ dbPath: ":memory:" });
    const gw = buildApp({ config: cfg(), store: empty, logger: silent() });
    const res = await gw.fetch(new Request("http://x/internal/agents"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).agents).toEqual([]);
    empty.close();
  });
});

describe("GET /internal/agents/:agentId", () => {
  it("separates api_call tools from mcp servers rather than flattening them", async () => {
    const res = await app().fetch(new Request("http://x/internal/agents/weather-bot"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.api_call_tools).toHaveLength(1);
    expect(body.api_call_tools[0]).toMatchObject({
      name: "get_forecast",
      method: "POST",
      path: "/api/forecast",
    });

    expect(body.mcp_servers).toHaveLength(1);
    expect(body.mcp_servers[0]).toMatchObject({
      name: "finance",
      url: "http://localhost:9/mcp",
    });
    // Distinct fields, not one merged list.
    expect(body.tools).toBeUndefined();
  });

  it("includes the system prompt and skills", async () => {
    const res = await app().fetch(new Request("http://x/internal/agents/weather-bot"));
    const body = (await res.json()) as any;
    expect(body.system_prompt).toBe("You are a weather bot.");
    expect(body.skills).toEqual([{ name: "jargon", source: "inline" }]);
  });

  it("reports MCP header names without their values", async () => {
    const res = await app().fetch(new Request("http://x/internal/agents/weather-bot"));
    const body = (await res.json()) as any;
    expect(body.mcp_servers[0].header_names).toEqual(["Authorization"]);
    expect(JSON.stringify(body)).not.toContain(MCP_HEADER_VALUE);
  });

  it("404s an unknown agent with a JSON error body", async () => {
    const res = await app().fetch(new Request("http://x/internal/agents/does-not-exist"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.error.message).toMatch(/unknown agent/);
  });
});

describe("internal payloads never disclose stored secrets", () => {
  it("leaks no app token or MCP header value from any read endpoint", async () => {
    const gw = app();
    const paths = [
      "/internal/agents",
      "/internal/agents/weather-bot",
      "/internal/agents/radar-bot",
      "/internal/agents/ledger-bot",
      "/internal/mcp/servers",
    ];
    for (const path of paths) {
      const text = await (await gw.fetch(new Request(`http://x${path}`))).text();
      expect(text, `${path} leaked an app token`).not.toContain(APP_TOKEN_A);
      expect(text, `${path} leaked an app token`).not.toContain(APP_TOKEN_B);
      expect(text, `${path} leaked an MCP header value`).not.toContain(MCP_HEADER_VALUE);
      expect(text, `${path} leaked a provider key`).not.toContain("prov-key-anthropic-SECRET");
      expect(text, `${path} leaked the gateway API key`).not.toContain("client-key");
    }
  });
});
