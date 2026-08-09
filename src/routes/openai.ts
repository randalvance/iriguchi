import { Hono } from "hono";
import { ulid } from "ulid";
import { bearerAuth } from "../auth.ts";
import type { Config } from "../config.ts";
import type { Store } from "../registry/store.ts";
import type { Logger } from "../logger.ts";
import { runAgentChunks, GatewayError } from "../agent/runner.ts";
import { streamChatRun, validateMessages, gatewayErrorResponse } from "./chat-run.ts";
import type { McpRuntime } from "../agent/mcp/discovery.ts";
import { aggregateChunks, type OpenAIChunk } from "../agent/openai-sse.ts";
import { parseClientContext, contextByteLength } from "../agent/context.ts";

export function openaiRoutes(deps: {
  config: Config;
  store: Store;
  logger: Logger;
  mcp?: McpRuntime;
}) {
  const app = new Hono();
  app.use("*", bearerAuth({ tokens: [deps.config.apiKey] }));

  app.get("/models", (c) => {
    const created = Math.floor(Date.now() / 1000);
    const allowed = [deps.config.providers[deps.config.defaultProvider].defaultModel];
    return c.json({
      object: "list",
      data: allowed.map((id) => ({ id, object: "model", created, owned_by: "iriguchi" })),
    });
  });

  app.post("/chat/completions", async (c) => {
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
    // OpenAI's default is non-streaming; a client that omits `stream` and
    // calls response.json() must get JSON, not SSE.
    if (body.stream !== undefined && typeof body.stream !== "boolean") {
      return c.json(
        {
          error: {
            type: "invalid_request_error",
            message: "stream must be a boolean when present",
          },
        },
        400,
      );
    }
    // Validated before the run starts, so an invalid context is always a JSON
    // 400 — never an SSE error event — whatever `stream` says.
    const parsedContext = parseClientContext(body.iri_context, deps.config.maxContextBytes);
    if (!parsedContext.ok) {
      return c.json(
        {
          error: {
            type: "invalid_request_error",
            code: parsedContext.code,
            message: parsedContext.message,
          },
        },
        400,
      );
    }
    const context = parsedContext.context;
    const wantsStream = body.stream === true;
    const showToolCalls = c.req.query("iri_show_tool_calls") === "true";
    logger.info("request.start", {
      method: "POST",
      path: "/v1/chat/completions",
      iri_agent: body.iri_agent ?? null,
      model: body.model ?? null,
      stream: wantsStream,
      // Key names and size only. Context carries whatever the calling app has
      // on screen — account identifiers, transaction rows — and none of that
      // belongs in a log aggregator.
      context_keys: Object.keys(context),
      context_bytes: contextByteLength(context),
    });

    const runnerOpts = {
      config: deps.config,
      store: deps.store,
      mcp: deps.mcp,
      logger,
      request: {
        requestId,
        agentId: typeof body.iri_agent === "string" ? body.iri_agent : null,
        model: typeof body.model === "string" ? body.model : null,
        messages,
        showToolCalls,
        context,
      },
    };

    try {
      if (!wantsStream) {
        // Nothing is committed to the wire until the run finishes, so any
        // error — including one raised mid-run — can still become a status
        // code via the catch below.
        const start = Date.now();
        const chunks: OpenAIChunk[] = [];
        for await (const chunk of runAgentChunks(runnerOpts)) {
          chunks.push(chunk);
        }
        const completion = aggregateChunks(chunks);
        logger.info("request.complete", { duration_ms: Date.now() - start, stream: false });
        c.header("X-Request-Id", requestId);
        return c.json(completion);
      }

      return await streamChatRun({ c, runnerOpts, logger, requestId });
    } catch (err) {
      if (err instanceof GatewayError) {
        return gatewayErrorResponse(c, err, requestId);
      }
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
