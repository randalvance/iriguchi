import { describe, it, expect } from "vitest";
import { spawn } from "../helpers/spawn.ts";
import { buildApp } from "../../src/server.ts";
import { createStore } from "../../src/registry/store.ts";
import { createLogger } from "../../src/logger.ts";
import { loadConfig } from "../../src/config.ts";
import { listen } from "../helpers/listen.ts";

const E2E = process.env.IRI_E2E === "1";

(E2E ? describe : describe.skip)("e2e: full flow", () => {
  it("registers an app, calls Claude, gets a real response", async () => {
    if (
      !process.env.IRI_PROVIDER_ANTHROPIC_API_KEY ||
      process.env.IRI_PROVIDER_ANTHROPIC_API_KEY === "test-anthropic-key"
    ) {
      throw new Error("real IRI_PROVIDER_ANTHROPIC_API_KEY required for e2e");
    }
    const config = loadConfig({
      ...process.env,
      IRI_DB_PATH: ":memory:",
      IRI_TMP_DIR: "./.iri-tmp-e2e",
      IRI_PORT: "0",
    });
    const logger = createLogger({ sink: () => {} });
    const store = createStore({ dbPath: config.dbPath });
    const gw = listen({
      port: 0,
      fetch: buildApp({ config: config, store, logger }).fetch,
      // Match src/server.ts: without this the server's request timeout can
      // close the socket while a slow provider is still evaluating the prompt.
      idleTimeout: 255,
    });

    const weatherProc = spawn({
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
      expect(port).toBeGreaterThan(0);

      const res = await fetch(`http://localhost:${gw.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          iri_agent: "weather-bot",
          messages: [{ role: "user", content: "What's the weather in San Francisco?" }],
          stream: true,
        }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("data: [DONE]");
      const contents = text
        .split("\n\n")
        .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
        .map((l) => {
          try {
            const obj = JSON.parse(l.slice(6));
            return obj.choices?.[0]?.delta?.content ?? "";
          } catch {
            return "";
          }
        })
        .join("");
      expect(contents.length).toBeGreaterThan(0);
    } finally {
      weatherProc.kill();
      gw.stop();
      store.close();
    }
  });
});
