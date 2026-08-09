import { Hono } from "hono";
import { ulid } from "ulid";
import type { Config } from "../config.ts";
import type { Store } from "../registry/store.ts";
import type { Logger } from "../logger.ts";
import type { McpRuntime } from "../agent/mcp/discovery.ts";
import { GatewayError } from "../agent/runner.ts";
import { streamChatRun, validateMessages, gatewayErrorResponse } from "./chat-run.ts";
import { listAgentSummaries, detailAgent, findAgent } from "../internal/catalog.ts";
import {
  collectMcpStatuses,
  probeMcpServer,
  resolveProbeTarget,
  ProbeTargetError,
  type McpStatusTracker,
} from "../internal/mcp-status.ts";

/**
 * The internal surface: what the first-party UI can see that an
 * OpenAI-compatible client cannot.
 *
 * Three properties hold across every handler here, and each is load-bearing
 * rather than stylistic:
 *
 * 1. **No authentication.** Deliberate, per the trusted-local-only decision.
 *    The router is only mounted when `IRI_UI_ENABLED` is true, and that flag
 *    defaults to off precisely because this is unauthenticated.
 * 2. **No secret ever reaches a payload.** Responses are assembled by
 *    `src/internal/catalog.ts` field by field. Stored records are never
 *    serialized directly, because `StoredApp.app_token` sits beside the
 *    manifest and MCP header values may be bearer tokens.
 * 3. **Reads only.** Nothing here mutates the registry. Registration, refresh,
 *    and deletion stay on `/apps/*`, where an app token is required.
 */
export function internalRoutes(deps: {
  config: Config;
  store: Store;
  logger: Logger;
  mcp: McpRuntime;
  tracker: McpStatusTracker;
}) {
  const app = new Hono();

  const notFound = (c: any, message: string) =>
    c.json({ error: { type: "invalid_request_error", message, code: "not_found" } }, 404);

  app.get("/agents", (c) => {
    return c.json({ agents: listAgentSummaries(deps.store, deps.config) });
  });

  app.get("/agents/:agentId", (c) => {
    const agentId = c.req.param("agentId");
    const found = findAgent(deps.store, agentId);
    if (!found) return notFound(c, `unknown agent: ${agentId}`);
    return c.json(detailAgent(found.app, found.agent, deps.config));
  });

  app.get("/mcp/servers", (c) => {
    // Cache-derived and network-free: loading the catalog must not hang on a
    // dead server, and rendering a page is not consent to dial out.
    return c.json({
      servers: collectMcpStatuses({
        store: deps.store,
        mcp: deps.mcp,
        tracker: deps.tracker,
      }),
      cache_ttl_ms: deps.config.mcpCacheTtlMs,
    });
  });

  app.post("/agents/:agentId/mcp/:serverName/probe", async (c) => {
    const agentId = c.req.param("agentId");
    const serverName = c.req.param("serverName");
    let entry;
    try {
      // Resolves through the registry: the request supplies two identifiers,
      // never a URL. See resolveProbeTarget for why.
      entry = resolveProbeTarget(deps.store, agentId, serverName);
    } catch (err) {
      if (err instanceof ProbeTargetError) return notFound(c, err.message);
      throw err;
    }
    const result = await probeMcpServer({
      entry,
      mcp: deps.mcp,
      tracker: deps.tracker,
      config: deps.config,
    });
    deps.logger.info("internal.mcp_probe", {
      agent: agentId,
      server: serverName,
      status: result.status,
    });
    // A failed probe is an outcome, not an error: "no, because ECONNREFUSED"
    // is a complete answer to "is it up", so it is a 200 carrying a status.
    return c.json(result);
  });

  app.post("/chat", async (c) => {
    const requestId = ulid();
    const logger = deps.logger.with({ request_id: requestId });

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { error: { type: "invalid_request_error", message: "invalid JSON body" } },
        400,
      );
    }

    const messages = validateMessages(body.messages);
    if (typeof messages === "string") {
      return c.json({ error: { type: "invalid_request_error", message: messages } }, 400);
    }

    const agentId = typeof body.agent_id === "string" ? body.agent_id : null;
    if (!agentId) {
      return c.json(
        { error: { type: "invalid_request_error", message: "agent_id is required" } },
        400,
      );
    }
    // Checked here as well as in the runner so an unknown agent costs nothing:
    // no skills materialized, no provider contacted.
    if (!findAgent(deps.store, agentId)) {
      return notFound(c, `unknown agent: ${agentId}`);
    }

    logger.info("request.start", {
      method: "POST",
      path: "/internal/chat",
      iri_agent: agentId,
      stream: true,
    });

    const runnerOpts = {
      config: deps.config,
      store: deps.store,
      mcp: deps.mcp,
      request: {
        requestId,
        agentId,
        // The agent's own model always wins here. A browser on an
        // unauthenticated surface does not get to choose what the gateway
        // spends tokens on.
        model: null,
        messages,
        showToolCalls: c.req.query("iri_show_tool_calls") === "true",
      },
    };

    try {
      return await streamChatRun({ c, runnerOpts, logger, requestId });
    } catch (err) {
      if (err instanceof GatewayError) return gatewayErrorResponse(c, err, requestId);
      logger.error("request.unhandled_error", { err: (err as Error).message });
      return c.json(
        { error: { type: "internal_error", message: "internal server error" } },
        500,
        { "X-Request-Id": requestId },
      );
    }
  });

  return app;
}
