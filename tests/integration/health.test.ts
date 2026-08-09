import { describe, it, expect } from "vitest";
import { buildApp } from "../../src/server.ts";

describe("server", () => {
  it("GET /healthz returns 200 ok", async () => {
    const app = buildApp({
      config: {
        port: 0,
        maxAgentTurns: 5,
        toolCallTimeoutMs: 1000,
        manifestCacheTtlMs: 1000,
        mcpCacheTtlMs: 300_000,
        maxContextBytes: 65536,
        mcpAllowedOrigins: [],
        requestTimeoutMs: 1000,
        dbPath: ":memory:",
        tmpDir: ".iri-tmp",
        providers: {
          anthropic: { name: "anthropic", apiKey: "ak", baseUrl: "https://api.anthropic.com", defaultModel: "claude-sonnet-4-6", authStyle: "api_key" as const },
        },
        defaultProvider: "anthropic",
        apiKey: "k",
        uiEnabled: false,
        uiDist: "./ui/dist",
        registrationSecret: "s",
      },
    });
    const res = await app.fetch(new Request("http://x/healthz"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("ok");
  });
});
