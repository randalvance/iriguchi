import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Config } from "./config.ts";
import { loadConfig } from "./config.ts";
import { createLogger, type Logger } from "./logger.ts";
import { createStore, type Store } from "./registry/store.ts";
import { openaiRoutes } from "./routes/openai.ts";
import { registrationRoutes } from "./routes/registration.ts";
import { startBackgroundRefresh } from "./registry/refresher.ts";
import { createMcpRuntime } from "./agent/mcp/index.ts";
import type { McpRuntime } from "./agent/mcp/discovery.ts";
import { internalRoutes } from "./routes/internal.ts";
import { createMcpStatusTracker, type McpStatusTracker } from "./internal/mcp-status.ts";

export type AppDeps = {
  config: Config;
  store?: Store;
  logger?: Logger;
  /** Supply one to share a pool and cache with a background refresher. */
  mcp?: McpRuntime;
  /** Supply one to share failure records with the runtime's discovery hook. */
  tracker?: McpStatusTracker;
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

  // Both mounts are conditional, so rolling the UI back is unsetting one
  // variable: with it off, the gateway serves exactly what it served before
  // this surface existed, and /internal/* is as unrouted as any other path.
  if (deps.config.uiEnabled) {
    logger.warn("ui.enabled", {
      ui_dist: deps.config.uiDist,
      message:
        "serving /ui and an UNAUTHENTICATED /internal/* surface on the gateway port; " +
        "do not expose this port beyond a trusted network",
    });
    const tracker = deps.tracker ?? createMcpStatusTracker();
    // Lazy discovery failures feed the tracker too, so a server that broke
    // during an ordinary run already reads as `unreachable` before anyone
    // presses probe. Only set if unclaimed — a caller that wired its own
    // observer meant it.
    mcp.onDiscoveryFailure ??= (entry, reason) => tracker.recordFailure(entry, reason);
    app.route(
      "/internal",
      internalRoutes({ config: deps.config, store, logger, mcp, tracker }),
    );
    mountUi(app, deps.config.uiDist);
  }

  return app;
}

/**
 * Serve the built UI at `/ui`.
 *
 * The gateway never builds: it serves files or explains why it cannot. An
 * unbuilt checkout is the overwhelmingly likely reason for a miss here, and a
 * bare 404 sends the reader looking for a routing bug instead of a build step.
 */
function mountUi(app: Hono, uiDist: string) {
  const root = relative(process.cwd(), resolve(uiDist)) || ".";

  app.use(
    "/ui/*",
    serveStatic({ root, rewriteRequestPath: (path) => path.replace(/^\/ui/, "") }),
  );
  app.get("/ui", (c) => c.redirect("/ui/"));

  // Reached when serveStatic finds nothing: either the build is missing
  // entirely, or it is a client-side route with no file behind it.
  app.get("/ui/*", (c) => {
    const built = existsSync(join(resolve(uiDist), "index.html"));
    if (!built) {
      return c.text(
        `iriguchi UI is not built.\n\nExpected assets at ${resolve(uiDist)}.\nRun: npm run ui:build\n`,
        503,
        { "Content-Type": "text/plain; charset=utf-8" },
      );
    }
    return c.text("not found\n", 404);
  });
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
