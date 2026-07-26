import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { buildApp } from "../../src/server.ts";
import { createStore, type Store } from "../../src/registry/store.ts";

let store: Store;
let appServer: ReturnType<typeof Bun.serve>;
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
  appServer = Bun.serve({ port: 0, fetch: appApp.fetch });
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
  requestTimeoutMs: 1000,
  dbPath: ":memory:",
  tmpDir: ".iri-tmp",
  providers: {
    anthropic: { name: "anthropic", apiKey: "ak", baseUrl: "https://api.anthropic.com", defaultModel: "claude-sonnet-4-6" },
  },
  defaultProvider: "anthropic",
  apiKey: "client-key",
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
