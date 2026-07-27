import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { buildApp } from "../../src/server.ts";
import { createStore } from "../../src/registry/store.ts";
import { createLogger } from "../../src/logger.ts";
import { loadConfig } from "../../src/config.ts";

// Gated smoke: one tool-calling turn through the gateway per configured
// provider. This is the check that replaced the old "Claude-family only"
// scope exclusion — it proves the model behind each Anthropic-shaped
// endpoint actually follows the agent loop's tool-use prompting.
//
// Run with IRI_E2E=1 and real IRI_PROVIDER_<NAME>_* triples in the env,
// e.g. anthropic (Claude direct), openrouter (Kimi), lmstudio (local).
//
// The case is parametrized over every configured provider, so covering a new
// one is a matter of configuring it — no new test code. For OpenRouter:
//
//   IRI_E2E=1 \
//   IRI_PROVIDER_OPENROUTER_API_KEY=sk-or-... \
//   IRI_PROVIDER_OPENROUTER_BASE_URL=https://openrouter.ai/api \
//   IRI_PROVIDER_OPENROUTER_DEFAULT_MODEL=moonshotai/kimi-k3 \
//   IRI_PROVIDER_OPENROUTER_AUTH_STYLE=auth_token \
//   bun run test:e2e
//
// This spends real tokens. It is also the only check that exercises the
// provider's tool translation: a model or runtime that cannot accept tool
// definitions fails the whole run, which is how the LM Studio incompatibility
// surfaced. `toolCalls > 0` below is the assertion that catches it.
const E2E = process.env.IRI_E2E === "1";

const config = E2E
  ? loadConfig({
      ...process.env,
      IRI_DB_PATH: ":memory:",
      IRI_TMP_DIR: "./.iri-tmp-e2e",
      IRI_PORT: "0",
    })
  : null;

const providerNames = config
  ? Object.keys(config.providers).filter(
      (n) => config.providers[n].apiKey !== "test-anthropic-key",
    )
  : [];

(E2E ? describe : describe.skip)("e2e: per-provider tool-calling smoke", () => {
  it.each(providerNames.map((n) => [n]))("provider %s completes a tool-calling turn", async (name) => {
    const logger = createLogger({ sink: () => {} });
    const store = createStore({ dbPath: ":memory:" });
    const gw = Bun.serve({
      port: 0,
      fetch: buildApp({ config: config!, store, logger }).fetch,
      // Match src/server.ts: Bun's 10s default idleTimeout closes the
      // socket while a slow provider is still evaluating the prompt.
      idleTimeout: 255,
    });

    let toolCalls = 0;
    const toolApp = new Hono();
    toolApp.post("/api/lookup", async (c) => {
      toolCalls += 1;
      return Response.json({ answer: "the magic number is 407" });
    });
    const toolServer = Bun.serve({ port: 0, fetch: toolApp.fetch });
    try {
      store.upsertApp({
        id: `smoke-${name}`,
        base_url: `http://localhost:${toolServer.port}`,
        app_token: "smoke-tok",
        manifest: {
          manifest_version: "1",
          app: { id: `smoke-${name}`, name: "Smoke", description: "provider smoke" },
          agents: [
            {
              id: `smoke-bot-${name}`,
              name: "Smoke Bot",
              description: "answers via lookup tool",
              system_prompt:
                "You must call the lookup tool to answer any question, then report its answer verbatim.",
              provider: name,
              tools: [
                {
                  type: "api_call",
                  name: "lookup",
                  description: "Looks up the magic number. Call this for any question about the magic number.",
                  parameters: { type: "object", properties: {}, required: [] },
                  endpoint: { method: "POST", path: "/api/lookup" },
                },
              ],
              skills: [],
            } as any,
          ],
        },
      });

      const res = await fetch(`http://localhost:${gw.port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config!.apiKey}`,
        },
        body: JSON.stringify({
          iri_agent: `smoke-bot-${name}`,
          messages: [{ role: "user", content: "What is the magic number?" }],
          stream: true,
        }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("data: [DONE]");
      expect(toolCalls).toBeGreaterThan(0);
      expect(text).toContain("407");
    } finally {
      toolServer.stop();
      gw.stop();
      store.close();
    }
  }, 120000);
});
