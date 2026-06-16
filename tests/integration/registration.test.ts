import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { buildApp } from "../../src/server.ts";
import { createStore, type Store } from "../../src/registry/store.ts";

let store: Store;
let appServer: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let manifestResponse: Record<string, unknown>;

beforeEach(() => {
  store = createStore({ dbPath: ":memory:" });
  manifestResponse = {
    manifest_version: "1",
    app: { id: "weather-app", name: "Weather", description: "d" },
    agents: [
      { id: "weather-bot", name: "Bot", description: "d", system_prompt: "p", tools: [], skills: [] },
    ],
  };
  const appApp = new Hono();
  appApp.get("/agents-manifest", (c) => {
    if (!c.req.header("Authorization")?.startsWith("Bearer ")) {
      return c.json({}, 401);
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
  defaultModel: "claude-sonnet-4-6",
  maxAgentTurns: 5,
  toolCallTimeoutMs: 1000,
  manifestCacheTtlMs: 1000,
  requestTimeoutMs: 1000,
  dbPath: ":memory:",
  tmpDir: ".iri-tmp",
  anthropicApiKey: "ak",
  anthropicBaseUrl: undefined,
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
