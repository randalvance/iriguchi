import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Config } from "./config.ts";
import { loadConfig } from "./config.ts";
import { createLogger, type Logger } from "./logger.ts";
import { createStore, type Store } from "./registry/store.ts";
import { openaiRoutes } from "./routes/openai.ts";
import { registrationRoutes } from "./routes/registration.ts";
import { startBackgroundRefresh } from "./registry/refresher.ts";

export type AppDeps = {
  config: Config;
  store?: Store;
  logger?: Logger;
};

export function buildApp(deps: AppDeps) {
  const logger = deps.logger ?? createLogger();
  const store = deps.store ?? createStore({ dbPath: deps.config.dbPath });
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ status: "ok" }));
  // Browser clients (e.g. the demo chat UI) call /v1 cross-origin with an
  // Authorization header, so the preflight must be answered before auth.
  app.use("/v1/*", cors());
  app.route("/v1", openaiRoutes({ config: deps.config, store, logger }));
  app.route("/apps", registrationRoutes({ config: deps.config, store, logger }));

  return app;
}

if (import.meta.main) {
  const config = loadConfig();
  const logger = createLogger();
  const store = createStore({ dbPath: config.dbPath });
  const app = buildApp({ config, store, logger });
  Bun.serve({
    port: config.port,
    fetch: app.fetch,
    // Bun's default idleTimeout (10s) kills SSE connections while slow
    // providers are still evaluating the prompt. Bun caps this at 255s.
    idleTimeout: Math.min(255, Math.ceil(config.requestTimeoutMs / 1000)),
  });
  startBackgroundRefresh({
    store,
    logger,
    ttlMs: config.manifestCacheTtlMs,
    intervalMs: 30000,
    config,
  });
  logger.info("server.start", { port: config.port });
}
