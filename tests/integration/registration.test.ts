import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { buildApp } from "../../src/server.ts";
import { createStore, type Store } from "../../src/registry/store.ts";
import { listen, type TestServer } from "../helpers/listen.ts";

let store: Store;
let appServer: TestServer;
let baseUrl: string;
let manifestResponse: Record<string, unknown>;
/** When set, the mock app refuses the manifest fetch with this status. */
let manifestStatus: number | null;
/** Every Bearer token the gateway presented on /agents-manifest, in order. */
let presentedTokens: string[];

beforeEach(() => {
  store = createStore({ dbPath: ":memory:" });
  manifestStatus = null;
  presentedTokens = [];
  manifestResponse = {
    manifest_version: "1",
    app: { id: "weather-app", name: "Weather", description: "d" },
    agents: [
      { id: "weather-bot", name: "Bot", description: "d", system_prompt: "p", tools: [], skills: [] },
    ],
  };
  const appApp = new Hono();
  appApp.get("/agents-manifest", (c) => {
    const auth = c.req.header("Authorization");
    // Presence-only, per the app contract: the token presented during initial
    // registration is one this app has never seen and cannot compare against.
    if (!auth?.startsWith("Bearer ") || auth.length <= 7) {
      return c.json({}, 401);
    }
    presentedTokens.push(auth.slice(7));
    if (manifestStatus !== null) {
      return c.json({ error: "refused" }, manifestStatus as 401);
    }
    return c.json(manifestResponse);
  });
  appServer = listen({ port: 0, fetch: appApp.fetch });
  baseUrl = `http://localhost:${appServer.port}`;
});
afterEach(() => {
  appServer.stop();
  store.close();
});

const cfg = () => ({
  port: 0,
  maxAgentTurns: 5,
  toolCallTimeoutMs: 1000,
  manifestCacheTtlMs: 1000,
  mcpCacheTtlMs: 300_000,
  maxContextBytes: 65536,
  mcpAllowedOrigins: [] as string[],
  requestTimeoutMs: 1000,
  dbPath: ":memory:",
  tmpDir: ".iri-tmp",
  providers: {
    anthropic: { name: "anthropic", apiKey: "ak", baseUrl: "https://api.anthropic.com", defaultModel: "claude-sonnet-4-6", authStyle: "api_key" as const },
  },
  defaultProvider: "anthropic",
  apiKey: "client-key",
  uiEnabled: false,
  uiDist: "./ui/dist",
  registrationSecret: "reg-secret",
});

describe("POST /apps/register", () => {
  it("rejects missing registration secret", async () => {
    const app = buildApp({ config: cfg(), store });
    const res = await app.fetch(new Request("http://x/apps/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "weather-app", base_url: baseUrl }),
    }));
    expect(res.status).toBe(401);
  });

  it("registers app, fetches manifest, returns app_token + accepted_agents", async () => {
    const app = buildApp({ config: cfg(), store });
    const res = await app.fetch(new Request("http://x/apps/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer reg-secret" },
      body: JSON.stringify({ id: "weather-app", base_url: baseUrl }),
    }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.app_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.accepted_agents).toEqual(["weather-bot"]);
    expect(store.getApp("weather-app")?.app_token).toBe(body.app_token);
  });

  it("rejects a manifest whose agent references an unconfigured provider", async () => {
    manifestResponse = {
      manifest_version: "1",
      app: { id: "bad-app", name: "b", description: "b" },
      agents: [
        {
          id: "bad-bot",
          name: "Bad",
          description: "d",
          system_prompt: "x",
          provider: "openrouter",
          tools: [],
          skills: [],
        },
      ],
    };
    const app = buildApp({ config: cfg(), store });
    const res = await app.fetch(new Request("http://x/apps/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer reg-secret" },
      body: JSON.stringify({ id: "bad-app", base_url: baseUrl }),
    }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("unknown_provider");
    expect(body.error.message).toMatch(/bad-bot.*openrouter.*anthropic/);
    expect(store.getApp("bad-app")).toBeNull();
  });

  it("502 when manifest fetch fails", async () => {
    const app = buildApp({ config: cfg(), store });
    const res = await app.fetch(new Request("http://x/apps/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer reg-secret" },
      body: JSON.stringify({ id: "x", base_url: "http://localhost:1" }),
    }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("app_unavailable");
    expect(store.getApp("x")).toBeNull();
  });

  it("presents the token it will return, to an app that has never seen it", async () => {
    const app = buildApp({ config: cfg(), store });
    const res = await app.fetch(new Request("http://x/apps/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer reg-secret" },
      body: JSON.stringify({ id: "weather-app", base_url: baseUrl }),
    }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(presentedTokens).toEqual([body.app_token]);
  });

  it("rotates the token on re-registration and presents the new one", async () => {
    const app = buildApp({ config: cfg(), store });
    const register = () =>
      app.fetch(new Request("http://x/apps/register", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer reg-secret" },
        body: JSON.stringify({ id: "weather-app", base_url: baseUrl }),
      }));
    const first = (await (await register()).json()) as any;
    const second = (await (await register()).json()) as any;
    expect(second.app_token).not.toBe(first.app_token);
    expect(presentedTokens).toEqual([first.app_token, second.app_token]);
    expect(store.getApp("weather-app")?.app_token).toBe(second.app_token);
  });

  for (const status of [401, 403]) {
    it(`diagnoses a ${status} from the manifest endpoint as manifest_unauthorized`, async () => {
      manifestStatus = status;
      const app = buildApp({ config: cfg(), store });
      const res = await app.fetch(new Request("http://x/apps/register", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer reg-secret" },
        body: JSON.stringify({ id: "weather-app", base_url: baseUrl }),
      }));
      expect(res.status).toBe(502);
      const body = (await res.json()) as any;
      expect(body.error.code).toBe("manifest_unauthorized");
      expect(body.error.type).toBe("app_unavailable");
      expect(body.error.message).toMatch(/non-empty Bearer token/);
      expect(body.error.message).toMatch(/cannot know the token yet/);
      expect(store.getApp("weather-app")).toBeNull();
    });
  }

  it("keeps app_unavailable for a 500 from the manifest endpoint", async () => {
    manifestStatus = 500;
    const app = buildApp({ config: cfg(), store });
    const res = await app.fetch(new Request("http://x/apps/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer reg-secret" },
      body: JSON.stringify({ id: "weather-app", base_url: baseUrl }),
    }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("app_unavailable");
  });

  it("keeps app_unavailable for a manifest that fails schema validation", async () => {
    manifestResponse = { manifest_version: "999" };
    const app = buildApp({ config: cfg(), store });
    const res = await app.fetch(new Request("http://x/apps/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer reg-secret" },
      body: JSON.stringify({ id: "weather-app", base_url: baseUrl }),
    }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("app_unavailable");
    expect(body.error.message).toMatch(/manifest validation failed/);
  });
});

describe("POST /apps/:id/refresh-manifest", () => {
  it("refreshes manifest with correct app_token", async () => {
    const app = buildApp({ config: cfg(), store });
    const reg = await app.fetch(new Request("http://x/apps/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer reg-secret" },
      body: JSON.stringify({ id: "weather-app", base_url: baseUrl }),
    }));
    const { app_token } = (await reg.json()) as any;
    (manifestResponse as any).agents = [
      ...(manifestResponse as any).agents,
      { id: "weather-bot-2", name: "B2", description: "d", system_prompt: "p", tools: [], skills: [] },
    ];
    const refresh = await app.fetch(new Request("http://x/apps/weather-app/refresh-manifest", {
      method: "POST",
      headers: { Authorization: `Bearer ${app_token}` },
    }));
    expect(refresh.status).toBe(200);
    expect(store.lookupAgent("weather-bot-2")?.app.id).toBe("weather-app");
  });

  it("diagnoses a 401 from the manifest endpoint as manifest_unauthorized", async () => {
    const app = buildApp({ config: cfg(), store });
    const reg = await app.fetch(new Request("http://x/apps/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer reg-secret" },
      body: JSON.stringify({ id: "weather-app", base_url: baseUrl }),
    }));
    const { app_token } = (await reg.json()) as any;
    manifestStatus = 401;
    const refresh = await app.fetch(new Request("http://x/apps/weather-app/refresh-manifest", {
      method: "POST",
      headers: { Authorization: `Bearer ${app_token}` },
    }));
    expect(refresh.status).toBe(502);
    const body = (await refresh.json()) as any;
    expect(body.error.code).toBe("manifest_unauthorized");
  });

  it("401 with wrong token", async () => {
    const app = buildApp({ config: cfg(), store });
    await app.fetch(new Request("http://x/apps/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer reg-secret" },
      body: JSON.stringify({ id: "weather-app", base_url: baseUrl }),
    }));
    const refresh = await app.fetch(new Request("http://x/apps/weather-app/refresh-manifest", {
      method: "POST",
      headers: { Authorization: "Bearer wrong" },
    }));
    expect(refresh.status).toBe(401);
  });
});

describe("DELETE /apps/:id", () => {
  it("deregisters and cascades agents", async () => {
    const app = buildApp({ config: cfg(), store });
    const reg = await app.fetch(new Request("http://x/apps/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer reg-secret" },
      body: JSON.stringify({ id: "weather-app", base_url: baseUrl }),
    }));
    const { app_token } = (await reg.json()) as any;
    const del = await app.fetch(new Request("http://x/apps/weather-app", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${app_token}` },
    }));
    expect(del.status).toBe(204);
    expect(store.getApp("weather-app")).toBeNull();
    expect(store.lookupAgent("weather-bot")).toBeNull();
  });
});

describe("POST /apps/register — mcp entries", () => {
  const register = (config: ReturnType<typeof cfg>) => {
    const app = buildApp({ config, store });
    return app.fetch(
      new Request("http://x/apps/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer reg-secret",
        },
        body: JSON.stringify({ id: "weather-app", base_url: baseUrl }),
      }),
    );
  };

  const withMcpTool = (tool: Record<string, unknown>) => {
    (manifestResponse.agents as any[])[0].tools = [tool];
  };

  it("accepts an mcp entry when no allowlist is configured", async () => {
    withMcpTool({ type: "mcp", name: "finance", url: "http://anywhere.example:8080/mcp" });
    const res = await register(cfg());
    expect(res.status).toBe(201);
  });

  it("accepts an mcp entry whose origin is on the allowlist", async () => {
    withMcpTool({ type: "mcp", name: "finance", url: "http://finance-mcp:8080/mcp" });
    const res = await register({ ...cfg(), mcpAllowedOrigins: ["http://finance-mcp:8080"] });
    expect(res.status).toBe(201);
  });

  it("rejects an mcp entry whose origin is not on the allowlist", async () => {
    withMcpTool({ type: "mcp", name: "finance", url: "http://evil.example/mcp" });
    const res = await register({ ...cfg(), mcpAllowedOrigins: ["http://finance-mcp:8080"] });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.code).toBe("mcp_origin_not_allowed");
    // The message has to name the agent, the server, and the allowlist, or the
    // app author cannot tell which of several entries is at fault.
    expect(body.error.message).toContain("weather-bot");
    expect(body.error.message).toContain("finance");
    expect(body.error.message).toContain("http://evil.example/mcp");
    expect(body.error.message).toContain("http://finance-mcp:8080");
  });

  it("does not persist the app when an mcp entry is rejected", async () => {
    withMcpTool({ type: "mcp", name: "finance", url: "http://evil.example/mcp" });
    await register({ ...cfg(), mcpAllowedOrigins: ["http://finance-mcp:8080"] });
    expect(store.getApp("weather-app")).toBeNull();
  });

  it("rejects a malformed mcp url at the schema layer", async () => {
    withMcpTool({ type: "mcp", name: "finance", url: "/mcp" });
    const res = await register(cfg());
    // A manifest that fails schema validation is an app-side problem.
    expect(res.status).toBe(502);
    const body: any = await res.json();
    expect(body.error.type).toBe("app_unavailable");
  });

  it("rejects an mcp server name that is not kebab-case", async () => {
    withMcpTool({ type: "mcp", name: "Finance_MCP", url: "http://finance-mcp:8080/mcp" });
    const res = await register(cfg());
    expect(res.status).toBe(502);
  });

  it("registers without contacting the mcp server", async () => {
    // The URL points at a port nothing is listening on; registration must not
    // care, because an mcp entry is a reference and its tools are discovered
    // at run time.
    withMcpTool({ type: "mcp", name: "finance", url: "http://127.0.0.1:1/mcp" });
    const res = await register(cfg());
    expect(res.status).toBe(201);
  });

  it("re-validates mcp entries on refresh-manifest", async () => {
    withMcpTool({ type: "mcp", name: "finance", url: "http://finance-mcp:8080/mcp" });
    const allowed = { ...cfg(), mcpAllowedOrigins: ["http://finance-mcp:8080"] };
    const created = await register(allowed);
    expect(created.status).toBe(201);
    const token = (await created.json() as any).app_token;

    // The allowlist tightens; the stored app stays as it was.
    const tightened = buildApp({ config: { ...cfg(), mcpAllowedOrigins: ["http://other:8080"] }, store });
    const res = await tightened.fetch(
      new Request("http://x/apps/weather-app/refresh-manifest", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json() as any).error.code).toBe("mcp_origin_not_allowed");
    expect(store.getApp("weather-app")).not.toBeNull();
  });
});

describe("reserved tool names", () => {
  const apiCallTool = (name: string) => ({
    type: "api_call",
    name,
    description: "d",
    parameters: { type: "object", properties: {} },
    endpoint: { method: "POST", path: "/api/thing" },
  });

  const register = (app: ReturnType<typeof buildApp>) =>
    app.fetch(
      new Request("http://x/apps/register", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer reg-secret" },
        body: JSON.stringify({ id: "weather-app", base_url: baseUrl }),
      }),
    );

  it("rejects an api_call tool named get_context and persists nothing", async () => {
    (manifestResponse.agents as any[])[0].tools = [apiCallTool("get_context")];
    const app = buildApp({ config: cfg(), store });
    const res = await register(app);
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("reserved_tool_name");
    expect(body.error.message).toContain("get_context");
    expect(store.getApp("weather-app")).toBeNull();
  });

  it("rejects it on refresh-manifest too", async () => {
    const app = buildApp({ config: cfg(), store });
    const first = await register(app);
    expect(first.status).toBe(201);
    const token = ((await first.json()) as any).app_token;

    (manifestResponse.agents as any[])[0].tools = [apiCallTool("get_context")];
    const res = await app.fetch(
      new Request("http://x/apps/weather-app/refresh-manifest", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe("reserved_tool_name");
  });

  it("allows an mcp server to advertise get_context, since its tools are prefixed", async () => {
    (manifestResponse.agents as any[])[0].tools = [
      { type: "mcp", name: "finance", url: "http://localhost:9/mcp", tools: ["get_context"] },
    ];
    const app = buildApp({ config: cfg(), store });
    expect((await register(app)).status).toBe(201);
  });

  it("accepts a when clause through registration and stores it", async () => {
    (manifestResponse.agents as any[])[0].tools = [
      { ...apiCallTool("apply_import_mapping"), when: { route: "/imports/preview" } },
    ];
    const app = buildApp({ config: cfg(), store });
    expect((await register(app)).status).toBe(201);
    const stored = store.getApp("weather-app");
    expect((stored!.manifest!.agents[0].tools[0] as any).when).toEqual({
      route: "/imports/preview",
    });
  });

  it("rejects a malformed when clause atomically", async () => {
    (manifestResponse.agents as any[])[0].tools = [
      { ...apiCallTool("apply_import_mapping"), when: { route: { regex: "^/imports" } } },
    ];
    const app = buildApp({ config: cfg(), store });
    const res = await register(app);
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error.type).toBe("app_unavailable");
    expect(store.getApp("weather-app")).toBeNull();
  });
});
