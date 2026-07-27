import { describe, it, expect } from "bun:test";
import { buildApp } from "../../src/server.ts";

const cfg = {
  port: 0,
  maxAgentTurns: 5,
  toolCallTimeoutMs: 1000,
  manifestCacheTtlMs: 1000,
  requestTimeoutMs: 1000,
  dbPath: ":memory:",
  tmpDir: ".iri-tmp",
  providers: {
    anthropic: { name: "anthropic", apiKey: "ak", baseUrl: "https://api.anthropic.com", defaultModel: "claude-sonnet-4-6", authStyle: "api_key" as const },
  },
  defaultProvider: "anthropic",
  apiKey: "client-key",
  registrationSecret: "reg",
};

describe("server smoke", () => {
  it("has /healthz", async () => {
    const app = buildApp({ config: cfg });
    expect((await app.fetch(new Request("http://x/healthz"))).status).toBe(200);
  });

  it("has /v1/models (auth required)", async () => {
    const app = buildApp({ config: cfg });
    expect((await app.fetch(new Request("http://x/v1/models"))).status).toBe(401);
  });

  it("has /apps/register (auth required)", async () => {
    const app = buildApp({ config: cfg });
    const res = await app.fetch(
      new Request("http://x/apps/register", { method: "POST", body: "{}" }),
    );
    expect(res.status).toBe(401);
  });
});
