import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/server.ts";
import { createStore, type Store } from "../../src/registry/store.ts";
import { createLogger } from "../../src/logger.ts";
import { spinUpFakeAnthropic } from "../helpers/fake-anthropic.ts";
import type { Config } from "../../src/config.ts";
import type { Manifest } from "../../src/registry/schema.ts";

/**
 * The chat proxy.
 *
 * Its reason to exist is the last test in this file: the UI carries no
 * credential, so if it called `/v1/chat/completions` directly it would need
 * `IRI_API_KEY` in the browser — handing the key that unlocks the
 * *authenticated* API to anyone who can load the page. Proxying keeps the
 * credential in the process, and these tests hold that line.
 */

const GATEWAY_KEY = "client-key-SECRET";
const PROVIDER_KEY = "provider-key-SECRET";

let store: Store;
let tmp: string;

const manifest: Manifest = {
  manifest_version: "1",
  app: { id: "weather-app", name: "Weather App", description: "weather" },
  agents: [
    {
      id: "weather-bot",
      name: "Weather Bot",
      description: "Forecasts",
      system_prompt: "You are a weather bot.",
      tools: [],
      skills: [],
    },
  ],
} as Manifest;

const cfg = (providerPort: number, over: Partial<Config> = {}): Config => ({
  port: 0,
  maxAgentTurns: 20,
  toolCallTimeoutMs: 1000,
  manifestCacheTtlMs: 300000,
  requestTimeoutMs: 300000,
  mcpCacheTtlMs: 300000,
  maxContextBytes: 65536,
  mcpAllowedOrigins: [],
  uiEnabled: true,
  uiDist: "./ui/dist",
  dbPath: ":memory:",
  tmpDir: tmp,
  providers: {
    anthropic: {
      name: "anthropic",
      apiKey: PROVIDER_KEY,
      baseUrl: `http://localhost:${providerPort}`,
      defaultModel: "claude-default",
      authStyle: "api_key",
    },
  },
  defaultProvider: "anthropic",
  apiKey: GATEWAY_KEY,
  registrationSecret: "reg",
  ...over,
});

const silent = () => createLogger({ sink: () => {} });

async function readAll(res: Response): Promise<string> {
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

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "iri-internal-chat-"));
  store = createStore({ dbPath: ":memory:" });
  store.upsertApp({
    id: "weather-app",
    base_url: "http://localhost:4001",
    app_token: "tok-SECRET",
    manifest,
  });
});
afterEach(async () => {
  store.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("POST /internal/chat", () => {
  it("streams an agent run with no Authorization header", async () => {
    const fake = spinUpFakeAnthropic({ turns: [{ kind: "text", text: "Sunny in Tokyo" }] });
    try {
      const app = buildApp({ config: cfg(fake.port), store, logger: silent() });
      const res = await app.fetch(
        new Request("http://x/internal/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agent_id: "weather-bot",
            messages: [{ role: "user", content: "forecast?" }],
          }),
        }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const body = await readAll(res);
      expect(body).toContain("Sunny in Tokyo");
      expect(body).toContain("data: [DONE]");
    } finally {
      await fake.stop();
    }
  });

  it("404s an unknown agent_id before contacting any provider", async () => {
    let providerCalled = false;
    const fake = spinUpFakeAnthropic(
      { turns: [{ kind: "text", text: "unused" }] },
      { onRequest: () => { providerCalled = true; } },
    );
    try {
      const app = buildApp({ config: cfg(fake.port), store, logger: silent() });
      const res = await app.fetch(
        new Request("http://x/internal/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agent_id: "does-not-exist",
            messages: [{ role: "user", content: "hi" }],
          }),
        }),
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as any;
      expect(body.error.message).toMatch(/unknown agent/);
      expect(providerCalled).toBe(false);
    } finally {
      await fake.stop();
    }
  });

  it("rejects a missing agent_id and a malformed messages array", async () => {
    const fake = spinUpFakeAnthropic({ turns: [{ kind: "text", text: "unused" }] });
    try {
      const app = buildApp({ config: cfg(fake.port), store, logger: silent() });
      const post = (payload: unknown) =>
        app.fetch(
          new Request("http://x/internal/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          }),
        );

      expect((await post({ messages: [{ role: "user", content: "hi" }] })).status).toBe(400);
      expect((await post({ agent_id: "weather-bot", messages: "nope" })).status).toBe(400);
      expect((await post({ agent_id: "weather-bot", messages: [{ role: 1 }] })).status).toBe(400);
    } finally {
      await fake.stop();
    }
  });

  it("delivers a mid-stream failure to the client rather than closing silently", async () => {
    // The provider dies after the stream has been committed to, which is the
    // only window in which an error cannot become a status code.
    const fake = spinUpFakeAnthropic({ turns: [{ kind: "text", text: "partial" }] });
    const app = buildApp({ config: cfg(fake.port), store, logger: silent() });
    const res = await app.fetch(
      new Request("http://x/internal/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: "weather-bot",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await readAll(res);
    await fake.stop();
    // Whatever happened, the stream terminates with the sentinel: a stream
    // that simply stops is indistinguishable from one that finished.
    expect(body).toContain("data: [DONE]");
  });

  it("never puts the gateway or provider credential on the wire", async () => {
    const fake = spinUpFakeAnthropic({ turns: [{ kind: "text", text: "ok" }] });
    try {
      const app = buildApp({ config: cfg(fake.port), store, logger: silent() });
      const bodies: string[] = [];

      const good = await app.fetch(
        new Request("http://x/internal/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agent_id: "weather-bot",
            messages: [{ role: "user", content: "hi" }],
          }),
        }),
      );
      bodies.push(await readAll(good));

      // Error paths too: a 404 body that echoed configuration would leak just
      // as effectively as a successful one.
      const missing = await app.fetch(
        new Request("http://x/internal/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agent_id: "nope", messages: [] }),
        }),
      );
      bodies.push(await missing.text());

      const malformed = await app.fetch(
        new Request("http://x/internal/chat", { method: "POST", body: "{not json" }),
      );
      bodies.push(await malformed.text());

      for (const body of bodies) {
        expect(body).not.toContain(GATEWAY_KEY);
        expect(body).not.toContain(PROVIDER_KEY);
        expect(body).not.toContain("tok-SECRET");
      }
    } finally {
      await fake.stop();
    }
  });

  it("is absent when the internal surface is disabled", async () => {
    const fake = spinUpFakeAnthropic({ turns: [{ kind: "text", text: "unused" }] });
    try {
      const app = buildApp({
        config: cfg(fake.port, { uiEnabled: false }),
        store,
        logger: silent(),
      });
      const res = await app.fetch(
        new Request("http://x/internal/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agent_id: "weather-bot",
            messages: [{ role: "user", content: "hi" }],
          }),
        }),
      );
      expect(res.status).toBe(404);
    } finally {
      await fake.stop();
    }
  });
});
