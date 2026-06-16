import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { createStore, type Store } from "../../src/registry/store.ts";
import { startBackgroundRefresh } from "../../src/registry/refresher.ts";
import { createLogger } from "../../src/logger.ts";

let store: Store;
let appServer: ReturnType<typeof Bun.serve>;
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
  appServer = Bun.serve({ port: 0, fetch: a.fetch });
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

describe("startBackgroundRefresh", () => {
  it("refreshes stale manifests on its tick", async () => {
    const logger = createLogger({ sink: () => {} });
    const handle = startBackgroundRefresh({
      store,
      logger,
      ttlMs: 0,
      intervalMs: 30,
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
      await Bun.sleep(120);
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
    });
    try {
      await Bun.sleep(120);
      expect(store.lookupAgent("bot-1")?.app.id).toBe("w");
    } finally {
      handle.stop();
    }
  });
});
