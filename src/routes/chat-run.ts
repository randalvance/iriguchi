import type { Context } from "hono";
import type { Logger } from "../logger.ts";
import {
  runAgentStream,
  GatewayError,
  type RunnerOpts,
  type ChatRequest,
} from "../agent/runner.ts";

/**
 * The streaming half of a chat response, shared by the public `/v1` route and
 * the internal chat proxy.
 *
 * Both surfaces run the *same* agent through the *same* runner; only their
 * request shape and their authentication differ. Sharing the response
 * machinery is what keeps that true — in particular, the internal proxy must
 * never satisfy a run by issuing an HTTP request back at `/v1`, which would
 * require the very API key the proxy exists to keep out of the browser.
 */

export type MessageInput = ChatRequest["messages"];

/**
 * Validate a `messages` array, returning it or an error string.
 *
 * The check is `role` and `content` are strings — not that `role` is one of
 * the three the runner names. Tightening it would reject requests `/v1` accepts
 * today, and this refactor is required to leave that surface unchanged; the
 * runner only ever compares roles, so an unexpected one degrades rather than
 * breaks. Hence the assertion here rather than a narrowing parse.
 */
export function validateMessages(messages: unknown): MessageInput | string {
  if (!Array.isArray(messages)) return "messages must be an array";
  const ok = messages.every(
    (m) => typeof (m as any)?.role === "string" && typeof (m as any)?.content === "string",
  );
  if (!ok) return "each message must have role and content as strings";
  return messages as MessageInput;
}

/**
 * Whether the caller asked to see the run's tool activity.
 *
 * The body field is the real control — every other one on this API
 * (`iri_agent`, `iri_context`, `stream`, `model`) travels in the body, and it
 * is the only form a browser can set, since the chat-ui proxy forwards bodies
 * and discards query strings. The query parameter stays as a fallback for the
 * callers that predate the body field.
 *
 * A non-boolean body value falls through to the query parameter rather than
 * failing the request: this is a display hint, not a mode selector like
 * `stream`, and refusing to run over it would be the worse outcome.
 */
export function resolveShowToolCalls(c: Context, body: unknown): boolean {
  const fromBody = (body as { iri_show_tool_calls?: unknown } | null)?.iri_show_tool_calls;
  if (typeof fromBody === "boolean") return fromBody;
  return c.req.query("iri_show_tool_calls") === "true";
}

export function gatewayErrorResponse(c: Context, err: GatewayError, requestId: string) {
  return c.json(
    { error: { type: err.type, message: err.message, code: err.code } },
    err.httpStatus as any,
    { "X-Request-Id": requestId },
  );
}

/**
 * Stream an agent run as OpenAI-shaped SSE.
 *
 * The first chunk is pulled before any header is committed, so a resolution
 * failure — unknown agent, unconfigured provider — still becomes an HTTP
 * status rather than a 200 whose body happens to contain an error. Once bytes
 * are on the wire that option is gone, and a mid-run failure is delivered as a
 * final SSE event instead: a stream that simply stops is indistinguishable from
 * one that finished.
 */
export async function streamChatRun(opts: {
  c: Context;
  runnerOpts: RunnerOpts;
  logger: Logger;
  requestId: string;
}): Promise<Response> {
  const { c, runnerOpts, logger, requestId } = opts;
  const iter = runAgentStream(runnerOpts)[Symbol.asyncIterator]();

  let first: IteratorResult<string>;
  try {
    first = await iter.next();
  } catch (err) {
    if (err instanceof GatewayError) return gatewayErrorResponse(c, err, requestId);
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
}
