import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { createStore, type Store } from "../../src/registry/store.ts";
import { startBackgroundRefresh } from "../../src/registry/refresher.ts";
import { createLogger } from "../../src/logger.ts";
import { setTimeout as sleep } from "node:timers/promises";
import { listen, type TestServer } from "../helpers/listen.ts";

let store: Store;
let appServer: TestServer;
let manifest: any;

beforeEach(() => {
  store = createStore({ dbPath: ":memory:" });
  manifest = {
    manifest_version: "1",
    app: { id: "w", name: "w", description: "w" },
    agents: [
      { id: "bot-1", name: "B", description: "d", system_prompt: "p", tools: [], skills: [] },
    ],
  };
  const a = new Hono();
  a.get("/agents-manifest", (c) => c.json(manifest));
  appServer = listen({ port: 0, fetch: a.fetch });
  store.upsertApp({
    id: "w",
    base_url: `http://localhost:${appServer.port}`,
    app_token: "t",
    manifest,
  });
});
afterEach(() => {
  appServer.stop();
  store.close();
});

const refresherConfig = () => ({
  providers: {
    anthropic: { name: "anthropic", apiKey: "ak", baseUrl: "https://api.anthropic.com", defaultModel: "claude-sonnet-4-6", authStyle: "api_key" as const },
  } as Record<string, { name: string; apiKey: string; baseUrl: string; defaultModel: string; authStyle: "api_key" }>,
});

describe("startBackgroundRefresh", () => {
  it("refreshes stale manifests on its tick", async () => {
    const logger = createLogger({ sink: () => {} });
    const handle = startBackgroundRefresh({
      store,
      logger,
      ttlMs: 0,
      intervalMs: 30,
      config: refresherConfig(),
    });
    try {
      manifest.agents.push({
        id: "bot-2",
        name: "B2",
        description: "d",
        system_prompt: "p",
        tools: [],
        skills: [],
      });
      await sleep(120);
      expect(store.lookupAgent("bot-2")?.app.id).toBe("w");
    } finally {
      handle.stop();
    }
  });

  it("keeps last-good on fetch failure (stale-on-error)", async () => {
    appServer.stop();
    const logger = createLogger({ sink: () => {} });
    const handle = startBackgroundRefresh({
      store,
      logger,
      ttlMs: 0,
      intervalMs: 30,
      config: refresherConfig(),
    });
    try {
      await sleep(120);
      expect(store.lookupAgent("bot-1")?.app.id).toBe("w");
    } finally {
      handle.stop();
    }
  });

  it("logs warning and keeps stale manifest when a refresh references an unknown provider", async () => {
    const warnings: Array<{ evt: string; fields: any }> = [];
    const logger = {
      debug: () => {},
      info: () => {},
      warn: (evt: string, fields: any) => warnings.push({ evt, fields }),
      error: () => {},
    };
    // Swap the served manifest to one referencing an unknown provider.
    manifest = {
      ...manifest,
      agents: [{ ...manifest.agents[0], provider: "openrouter" }],
    };
    const handle = startBackgroundRefresh({
      store,
      logger: logger as any,
      ttlMs: 0,
      intervalMs: 30,
      config: refresherConfig(),
    });
    try {
      await sleep(120);
      const stored = store.getApp("w");
      expect(stored?.manifest?.agents[0].provider).toBeUndefined();
      const warn = warnings.find(
        (w) => w.evt === "manifest.refresh_failed" && w.fields.reason === "unknown_provider",
      );
      expect(warn).toBeDefined();
      expect(warn?.fields.agent_id).toBe("bot-1");
    } finally {
      handle.stop();
    }
  });
});
