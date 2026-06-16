import { Hono } from "hono";
import { ulid } from "ulid";
import { bearerAuth } from "../auth.ts";
import type { Config } from "../config.ts";
import type { Store } from "../registry/store.ts";
import type { Logger } from "../logger.ts";
import { runAgentStream, GatewayError } from "../agent/runner.ts";

export function openaiRoutes(deps: { config: Config; store: Store; logger: Logger }) {
  const app = new Hono();
  app.use("*", bearerAuth({ tokens: [deps.config.apiKey] }));

  app.get("/models", (c) => {
    const created = Math.floor(Date.now() / 1000);
    const allowed = [deps.config.defaultModel, "claude-opus-4-8", "claude-haiku-4-5"];
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
    if (!Array.isArray(body.messages)) {
      return c.json(
        { error: { type: "invalid_request_error", message: "messages must be an array" } },
        400,
      );
    }
    const showToolCalls = c.req.query("iri_show_tool_calls") === "true";
    logger.info("request.start", {
      method: "POST",
      path: "/v1/chat/completions",
      iri_agent: body.iri_agent ?? null,
      model: body.model ?? null,
    });

    try {
      const stream = runAgentStream({
        config: deps.config,
        store: deps.store,
        request: {
          requestId,
          agentId: typeof body.iri_agent === "string" ? body.iri_agent : null,
          model: typeof body.model === "string" ? body.model : null,
          messages: body.messages,
          showToolCalls,
        },
      });

      // Eager-probe the first chunk so GatewayError becomes an HTTP status
      // before we've committed to streaming.
      const iter = stream[Symbol.asyncIterator]();
      let first: IteratorResult<string>;
      try {
        first = await iter.next();
      } catch (err) {
        if (err instanceof GatewayError) {
          return c.json(
            { error: { type: err.type, message: err.message, code: err.code } },
            err.httpStatus as any,
            { "X-Request-Id": requestId },
          );
        }
        throw err;
      }

      c.header("X-Request-Id", requestId);
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      c.header("Connection", "keep-alive");
      const start = Date.now();

      return c.body(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            const encoder = new TextEncoder();
            try {
              if (!first.done) controller.enqueue(encoder.encode(first.value));
              while (true) {
                const { done, value } = await iter.next();
                if (done) break;
                controller.enqueue(encoder.encode(value));
              }
              logger.info("request.complete", { duration_ms: Date.now() - start });
            } catch (err) {
              logger.error("request.stream_error", {
                err: (err as Error).message,
                duration_ms: Date.now() - start,
              });
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ error: (err as Error).message })}\n\n`),
              );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            } finally {
              controller.close();
            }
          },
        }),
      );
    } catch (err) {
      if (err instanceof GatewayError) {
        return c.json(
          { error: { type: err.type, message: err.message, code: err.code } },
          err.httpStatus as any,
          { "X-Request-Id": requestId },
        );
      }
      logger.error("request.unhandled_error", { err: (err as Error).message });
      return c.json(
        { error: { type: "internal_error", message: (err as Error).message } },
        500,
        { "X-Request-Id": requestId },
      );
    }
  });

  return app;
}
