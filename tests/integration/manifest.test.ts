import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { fetchManifest, ManifestFetchError } from "../../src/registry/manifest.ts";

function spinUpMockApp(handler: (c: any) => Response | Promise<Response>) {
  const app = new Hono();
  app.get("/agents-manifest", (c) => handler(c));
  return Bun.serve({ port: 0, fetch: app.fetch });
}

describe("fetchManifest", () => {
  it("fetches and parses a valid manifest", async () => {
    const server = spinUpMockApp((c) => {
      const auth = c.req.header("Authorization");
      if (auth !== "Bearer expected-token") {
        return new Response("unauth", { status: 401 });
      }
      return Response.json({
        manifest_version: "1",
        app: { id: "weather-app", name: "Weather", description: "d" },
        agents: [
          {
            id: "weather-bot",
            name: "Bot",
            description: "d",
            system_prompt: "p",
            tools: [],
            skills: [],
          },
        ],
      });
    });
    try {
      const manifest = await fetchManifest({
        baseUrl: `http://localhost:${server.port}`,
        appToken: "expected-token",
      });
      expect(manifest.app.id).toBe("weather-app");
      expect(manifest.agents[0].id).toBe("weather-bot");
    } finally {
      server.stop();
    }
  });

  it("throws ManifestFetchError on non-2xx", async () => {
    const server = spinUpMockApp(() => new Response("server fail", { status: 500 }));
    try {
      await expect(
        fetchManifest({ baseUrl: `http://localhost:${server.port}`, appToken: "t" }),
      ).rejects.toThrow(ManifestFetchError);
    } finally {
      server.stop();
    }
  });

  it("throws ManifestFetchError on invalid manifest", async () => {
    const server = spinUpMockApp(() => Response.json({ manifest_version: "999" }));
    try {
      await expect(
        fetchManifest({ baseUrl: `http://localhost:${server.port}`, appToken: "t" }),
      ).rejects.toThrow(ManifestFetchError);
    } finally {
      server.stop();
    }
  });

  it("throws ManifestFetchError on connection failure", async () => {
    await expect(
      fetchManifest({ baseUrl: "http://localhost:1", appToken: "t" }),
    ).rejects.toThrow(ManifestFetchError);
  });

  it("respects a custom timeout", async () => {
    const server = spinUpMockApp(async () => {
      await Bun.sleep(200);
      return Response.json({});
    });
    try {
      await expect(
        fetchManifest({
          baseUrl: `http://localhost:${server.port}`,
          appToken: "t",
          timeoutMs: 50,
        }),
      ).rejects.toThrow(ManifestFetchError);
    } finally {
      server.stop();
    }
  });
});
