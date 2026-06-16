import { Hono } from "hono";
import type { Config } from "./config.ts";
import { loadConfig } from "./config.ts";
import { createLogger, type Logger } from "./logger.ts";
import { createStore, type Store } from "./registry/store.ts";
import { openaiRoutes } from "./routes/openai.ts";
import { registrationRoutes } from "./routes/registration.ts";

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

  app.route("/v1", openaiRoutes({ config: deps.config, store, logger }));
  app.route("/apps", registrationRoutes({ config: deps.config, store, logger }));

  return app;
}

if (import.meta.main) {
  const config = loadConfig();
  const logger = createLogger();
  const app = buildApp({ config, logger });
  Bun.serve({ port: config.port, fetch: app.fetch });
  logger.info("server.start", { port: config.port });
}
