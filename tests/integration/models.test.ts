import { describe, it, expect } from "vitest";
import { buildApp } from "../../src/server.ts";

const cfg = {
  port: 0,
  maxAgentTurns: 5,
  toolCallTimeoutMs: 1000,
  manifestCacheTtlMs: 1000,
  mcpCacheTtlMs: 300_000,
  mcpAllowedOrigins: [],
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
  registrationSecret: "reg",
};

describe("GET /v1/models", () => {
  it("requires bearer auth", async () => {
    const app = buildApp({ config: cfg });
    const res = await app.fetch(new Request("http://x/v1/models"));
    expect(res.status).toBe(401);
  });

  it("returns exactly the default provider's default model, no hardcoded ids", async () => {
    const app = buildApp({ config: cfg });
    const res = await app.fetch(
      new Request("http://x/v1/models", {
        headers: { Authorization: "Bearer client-key" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.object).toBe("list");
    const ids = body.data.map((m: any) => m.id);
    expect(ids).toEqual(["claude-sonnet-4-6"]);
    body.data.forEach((m: any) => {
      expect(m.object).toBe("model");
      expect(typeof m.created).toBe("number");
    });
  });
});
