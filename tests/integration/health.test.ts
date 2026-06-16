import { describe, it, expect } from "bun:test";
import { buildApp } from "../../src/server.ts";

describe("server", () => {
  it("GET /healthz returns 200 ok", async () => {
    const app = buildApp({
      config: {
        port: 0,
        defaultModel: "x",
        maxAgentTurns: 5,
        toolCallTimeoutMs: 1000,
        manifestCacheTtlMs: 1000,
        requestTimeoutMs: 1000,
        dbPath: ":memory:",
        tmpDir: ".iri-tmp",
        anthropicApiKey: "ak",
        anthropicBaseUrl: undefined,
        apiKey: "k",
        registrationSecret: "s",
      },
    });
    const res = await app.fetch(new Request("http://x/healthz"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("ok");
  });
});
