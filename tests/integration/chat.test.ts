import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { buildApp } from "../../src/server.ts";
import { createStore, type Store } from "../../src/registry/store.ts";
import { spinUpFakeAnthropic } from "../helpers/fake-anthropic.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;
let store: Store;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "iri-chat-"));
  store = createStore({ dbPath: ":memory:" });
});
afterEach(async () => {
  store.close();
  await rm(tmp, { recursive: true, force: true });
});

const baseCfg = () => ({
  port: 0,
  defaultModel: "claude-sonnet-4-6",
  maxAgentTurns: 5,
  toolCallTimeoutMs: 1000,
  manifestCacheTtlMs: 1000,
  requestTimeoutMs: 5000,
  dbPath: ":memory:",
  tmpDir: tmp,
  anthropicApiKey: "ak",
  anthropicBaseUrl: undefined as string | undefined,
  apiKey: "client-key",
  registrationSecret: "reg",
});

async function readAllSse(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
  }
  return out;
}

describe("POST /v1/chat/completions", () => {
  it("rejects unauthorized", async () => {
    const app = buildApp({ config: baseCfg(), store });
    const res = await app.fetch(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("streams generic-agent SSE", async () => {
    const fake = spinUpFakeAnthropic({ turns: [{ kind: "text", text: "Hi there" }] });
    try {
      const cfg = { ...baseCfg(), anthropicBaseUrl: `http://localhost:${fake.port}` };
      const app = buildApp({ config: cfg, store });
      const res = await app.fetch(
        new Request("http://x/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer client-key" },
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            messages: [{ role: "user", content: "hi" }],
            stream: true,
          }),
        }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const body = await readAllSse(res);
      expect(body).toContain("Hi there");
      expect(body).toContain("data: [DONE]");
    } finally {
      fake.stop();
    }
  });

  it("returns 404 for unknown iri_agent", async () => {
    const fake = spinUpFakeAnthropic({ turns: [{ kind: "text", text: "unused" }] });
    try {
      const cfg = { ...baseCfg(), anthropicBaseUrl: `http://localhost:${fake.port}` };
      const app = buildApp({ config: cfg, store });
      const res = await app.fetch(
        new Request("http://x/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer client-key" },
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            messages: [{ role: "user", content: "hi" }],
            iri_agent: "missing",
            stream: true,
          }),
        }),
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as any;
      expect(body.error.code).toBe("unknown_agent");
    } finally {
      fake.stop();
    }
  });

  it("includes X-Request-Id header", async () => {
    const fake = spinUpFakeAnthropic({ turns: [{ kind: "text", text: "x" }] });
    try {
      const cfg = { ...baseCfg(), anthropicBaseUrl: `http://localhost:${fake.port}` };
      const app = buildApp({ config: cfg, store });
      const res = await app.fetch(
        new Request("http://x/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer client-key" },
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            messages: [{ role: "user", content: "hi" }],
            stream: true,
          }),
        }),
      );
      expect(res.headers.get("X-Request-Id")).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      await readAllSse(res);
    } finally {
      fake.stop();
    }
  });
});
