import { describe, it, expect, beforeEach } from "bun:test";
import { createStore, type Store } from "../../src/registry/store.ts";
import type { Manifest } from "../../src/registry/schema.ts";

function fixtureManifest(appId = "weather-app", agentIds = [appId + "-bot"]): Manifest {
  return {
    manifest_version: "1",
    app: { id: appId, name: appId, description: appId },
    agents: agentIds.map((id) => ({
      id,
      name: id,
      description: id,
      system_prompt: "p",
      tools: [],
      skills: [],
    })),
  } as Manifest;
}

describe("store", () => {
  let store: Store;

  beforeEach(() => {
    store = createStore({ dbPath: ":memory:" });
  });

  it("upsertApp persists an app with manifest and agents", () => {
    const m = fixtureManifest();
    store.upsertApp({
      id: "weather-app",
      base_url: "http://localhost:4001",
      app_token: "tok-1",
      manifest: m,
    });
    const app = store.getApp("weather-app");
    expect(app?.base_url).toBe("http://localhost:4001");
    expect(app?.app_token).toBe("tok-1");
    expect(app?.manifest?.agents[0].id).toBe("weather-app-bot");
    expect(app?.manifest_fetched_at).toBeGreaterThan(0);
  });

  it("lookupAgent returns owning app + agent", () => {
    store.upsertApp({
      id: "weather-app",
      base_url: "http://localhost:4001",
      app_token: "tok-1",
      manifest: fixtureManifest(),
    });
    const found = store.lookupAgent("weather-app-bot");
    expect(found?.app.id).toBe("weather-app");
    expect(found?.agent.id).toBe("weather-app-bot");
  });

  it("lookupAgent returns null for unknown agent", () => {
    expect(store.lookupAgent("nope")).toBeNull();
  });

  it("replacing manifest re-syncs agents (deletes removed, adds new)", () => {
    store.upsertApp({
      id: "weather-app",
      base_url: "http://localhost:4001",
      app_token: "tok-1",
      manifest: fixtureManifest("weather-app", ["weather-bot", "old-bot"]),
    });
    expect(store.lookupAgent("old-bot")?.app.id).toBe("weather-app");

    store.upsertApp({
      id: "weather-app",
      base_url: "http://localhost:4001",
      app_token: "tok-1",
      manifest: fixtureManifest("weather-app", ["weather-bot", "new-bot"]),
    });
    expect(store.lookupAgent("old-bot")).toBeNull();
    expect(store.lookupAgent("new-bot")?.app.id).toBe("weather-app");
  });

  it("deleteApp cascades to its agents", () => {
    store.upsertApp({
      id: "weather-app",
      base_url: "http://localhost:4001",
      app_token: "tok-1",
      manifest: fixtureManifest(),
    });
    // Verify the agent IS present before delete (otherwise the post-delete
    // assertion would pass trivially).
    expect(store.lookupAgent("weather-app-bot")?.app.id).toBe("weather-app");

    store.deleteApp("weather-app");
    expect(store.getApp("weather-app")).toBeNull();
    expect(store.lookupAgent("weather-app-bot")).toBeNull();
  });

  it("listApps returns all rows", () => {
    store.upsertApp({
      id: "a",
      base_url: "http://x:1",
      app_token: "t1",
      manifest: fixtureManifest("a"),
    });
    store.upsertApp({
      id: "b",
      base_url: "http://x:2",
      app_token: "t2",
      manifest: fixtureManifest("b"),
    });
    const ids = store.listApps().map((a) => a.id).sort();
    expect(ids).toEqual(["a", "b"]);
  });

  it("rejects agent id reused across apps", () => {
    store.upsertApp({
      id: "a",
      base_url: "http://x:1",
      app_token: "t1",
      manifest: fixtureManifest("a", ["shared-bot"]),
    });
    expect(() =>
      store.upsertApp({
        id: "b",
        base_url: "http://x:2",
        app_token: "t2",
        manifest: fixtureManifest("b", ["shared-bot"]),
      }),
    ).toThrow();
  });
});
