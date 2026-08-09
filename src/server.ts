import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Config } from "./config.ts";
import { loadConfig } from "./config.ts";
import { createLogger, type Logger } from "./logger.ts";
import { createStore, type Store } from "./registry/store.ts";
import { openaiRoutes } from "./routes/openai.ts";
import { registrationRoutes } from "./routes/registration.ts";
import { startBackgroundRefresh } from "./registry/refresher.ts";
import { createMcpRuntime } from "./agent/mcp/index.ts";
import type { McpRuntime } from "./agent/mcp/discovery.ts";

export type AppDeps = {
  config: Config;
  store?: Store;
  logger?: Logger;
  /** Supply one to share a pool and cache with a background refresher. */
  mcp?: McpRuntime;
};

export function buildApp(deps: AppDeps) {
  const logger = deps.logger ?? createLogger();
  const store = deps.store ?? createStore({ dbPath: deps.config.dbPath });
  const mcp = deps.mcp ?? createMcpRuntime({ config: deps.config, logger });
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ status: "ok" }));
  // Browser clients (e.g. the demo chat UI) call /v1 cross-origin with an
  // Authorization header, so the preflight must be answered before auth.
  app.use("/v1/*", cors());
  app.route("/v1", openaiRoutes({ config: deps.config, store, logger, mcp }));
  app.route("/apps", registrationRoutes({ config: deps.config, store, logger }));

  return app;
}

if (import.meta.filename === process.argv[1]) {
  const config = loadConfig();
  const logger = createLogger();
  const store = createStore({ dbPath: config.dbPath });
  const mcp = createMcpRuntime({ config, logger });
  const app = buildApp({ config, store, logger, mcp });
  serve({
    port: config.port,
    fetch: app.fetch,
    // Node's default requestTimeout (300s) would cut SSE connections short
    // while a slow provider is still evaluating the prompt. Disable it here
    // and let IRI_REQUEST_TIMEOUT_MS govern the request lifetime instead.
    serverOptions: { requestTimeout: 0, headersTimeout: 0 },
  });
  startBackgroundRefresh({
    store,
    logger,
    ttlMs: config.manifestCacheTtlMs,
    intervalMs: 30000,
    config,
    mcp,
  });
  logger.info("server.start", { port: config.port });
}
