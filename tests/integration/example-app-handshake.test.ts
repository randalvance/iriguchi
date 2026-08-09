import { describe, it, expect } from "vitest";
import { spawn } from "../helpers/spawn.ts";
import { buildApp } from "../../src/server.ts";
import { createStore } from "../../src/registry/store.ts";
import { createLogger } from "../../src/logger.ts";
import { listen } from "../helpers/listen.ts";

/**
 * Drives the real weather-app example against a real gateway to prove the
 * registration handshake and both auth rules hold end to end. No LLM is
 * involved: the app's endpoints are exercised directly, so this runs in CI
 * alongside the rest of the suite.
 */
describe("example app handshake", () => {
  it("registers via presence-only manifest auth, then enforces exact token equality on tools", async () => {
    const store = createStore({ dbPath: ":memory:" });
    const config = {
      port: 0,
      maxAgentTurns: 5,
      toolCallTimeoutMs: 2000,
      manifestCacheTtlMs: 60_000,
      mcpCacheTtlMs: 300_000,
      maxContextBytes: 65536,
      mcpAllowedOrigins: [] as string[],
      requestTimeoutMs: 5000,
      dbPath: ":memory:",
      tmpDir: "./.iri-tmp-example",
      providers: {
        anthropic: {
          name: "anthropic",
          apiKey: "unused",
          baseUrl: "http://localhost:1",
          defaultModel: "claude-sonnet-4-6",
          authStyle: "api_key" as const,
        },
      },
      defaultProvider: "anthropic",
      apiKey: "client-key",
      registrationSecret: "reg-secret",
    };
    const logger = createLogger({ sink: () => {} });
    const gw = listen({
      port: 0,
      fetch: buildApp({ config: config as any, store, logger }).fetch,
    });

    const weatherProc = spawn({
      // process.execPath, not "node": the test runner's own binary is always
      // present, whichever Node install is on PATH.
      cmd: [process.execPath, "examples/weather-app/src/server.ts"],
      env: {
        ...process.env,
        WEATHER_PORT: "0",
        IRI_GATEWAY_URL: `http://localhost:${gw.port}`,
        IRI_REGISTRATION_SECRET: config.registrationSecret,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const reader = weatherProc.stdout!.getReader();
      const decoder = new TextDecoder();
      const deadline = Date.now() + 15000;
      let buf = "";
      let port = 0;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value);
        const m = buf.match(/listening on http:\/\/localhost:(\d+)/);
        if (m) port = Number(m[1]);
        if (port && buf.includes("registered, agents:")) break;
      }

      // Registration completed: the app served its manifest to a token it had
      // never seen, and the gateway stored the agent it advertised.
      expect(port).toBeGreaterThan(0);
      expect(buf).toContain("registered, agents:");
      const stored = store.getApp("weather-app");
      expect(stored).not.toBeNull();
      expect(store.lookupAgent("weather-bot")?.app.id).toBe("weather-app");
      const appToken = stored!.app_token;

      const appUrl = `http://localhost:${port}`;

      // Manifest: presence-only.
      expect((await fetch(`${appUrl}/agents-manifest`)).status).toBe(401);
      expect(
        (await fetch(`${appUrl}/agents-manifest`, { headers: { Authorization: "Bearer " } }))
          .status,
      ).toBe(401);
      expect(
        (await fetch(`${appUrl}/agents-manifest`, { headers: { Authorization: "Basic xyz" } }))
          .status,
      ).toBe(401);
      const anyToken = await fetch(`${appUrl}/agents-manifest`, {
        headers: { Authorization: "Bearer a-token-this-app-has-never-seen" },
      });
      expect(anyToken.status).toBe(200);
      expect(((await anyToken.json()) as any).app.id).toBe("weather-app");

      // Tool endpoint: exact equality.
      const forecast = (auth: string | null) =>
        fetch(`${appUrl}/api/forecast`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(auth ? { Authorization: auth } : {}),
          },
          body: JSON.stringify({ location: "Tokyo", days: 1 }),
        });
      expect((await forecast(null)).status).toBe(401);
      expect((await forecast("Bearer a-token-this-app-has-never-seen")).status).toBe(401);
      expect((await forecast(`Bearer ${appToken}x`)).status).toBe(401);
      const authorized = await forecast(`Bearer ${appToken}`);
      expect(authorized.status).toBe(200);
      expect((await authorized.json()) as any).toHaveProperty("location");
    } finally {
      weatherProc.kill();
      gw.stop();
      store.close();
    }
  });
});
