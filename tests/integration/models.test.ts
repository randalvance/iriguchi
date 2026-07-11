import { describe, it, expect } from "bun:test";
import { buildApp } from "../../src/server.ts";

const cfg = {
  port: 0,
  defaultModel: "claude-sonnet-4-6",
  maxAgentTurns: 5,
  toolCallTimeoutMs: 1000,
  manifestCacheTtlMs: 1000,
  requestTimeoutMs: 1000,
  dbPath: ":memory:",
  tmpDir: ".iri-tmp",
  providers: {
    anthropic: { name: "anthropic", apiKey: "ak", baseUrl: "https://api.anthropic.com" },
  },
  defaultProvider: "anthropic",
  apiKey: "client-key",
  registrationSecret: "reg",
};

describe("GET /v1/models", () => {
  it("requires bearer auth", async () => {
    const app = buildApp({ config: cfg });
    const res = await app.fetch(new Request("http://x/v1/models"));
    expect(res.status).toBe(401);
  });

  it("returns OpenAI-shape model list", async () => {
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
    expect(ids).toContain("claude-sonnet-4-6");
    body.data.forEach((m: any) => {
      expect(m.object).toBe("model");
      expect(typeof m.created).toBe("number");
    });
  });
});
