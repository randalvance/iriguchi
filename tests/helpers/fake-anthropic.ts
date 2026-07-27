import { Hono } from "hono";

export type ScriptedTurn =
  | { kind: "text"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: unknown; text?: string };

/**
 * A "scripted" sequence of responses.
 * Each element of `responses` is what the fake Anthropic returns on successive
 * API calls. Within each response, multiple blocks can appear (e.g. text + tool_use).
 *
 * For backwards compat, `turns` is still accepted and treated as a single response.
 */
export type Scripted = {
  /** Multiple distinct API responses (one per API call round-trip). */
  responses?: Array<ScriptedTurn[]>;
  /** Shorthand: all turns returned in a single API response. */
  turns?: ScriptedTurn[];
  /**
   * Content-aware scripting. Given the inbound request body, return the turns
   * to emit. Prefer this over `responses` when the assertion depends on the
   * agent loop's real call sequence: the SDK issues a preliminary tool-less
   * call before the agent turn, so index-based scripting silently misaligns
   * and can make a tool test pass without the tool ever being invoked.
   */
  respond?: (body: any) => ScriptedTurn[];
};

export type ObservedRequest = { headers: Headers; body: any };

export type FakeAnthropicOpts = {
  /** Called with the headers and parsed body of every /v1/messages request. */
  onRequest?: (request: ObservedRequest) => void;
};

export function spinUpFakeAnthropic(script: Scripted, opts: FakeAnthropicOpts = {}) {
  // Normalise to an array-of-responses.
  const responses: ScriptedTurn[][] = script.responses
    ? script.responses
    : [script.turns ?? []];

  let callCount = 0;
  const app = new Hono();
  app.post("/v1/messages", async (_c) => {
    if (opts.onRequest) {
      const body = await _c.req.raw.clone().json().catch(() => null);
      opts.onRequest({ headers: _c.req.raw.headers, body });
    }
    let turns: ScriptedTurn[];
    if (script.respond) {
      turns = script.respond(await _c.req.raw.clone().json().catch(() => ({})));
    } else {
      const idx = callCount < responses.length ? callCount : responses.length - 1;
      turns = responses[idx];
    }
    callCount++;
    return new Response(streamFor(turns), {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  });
  return Bun.serve({ port: 0, fetch: app.fetch });
}

function sse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function streamFor(turns: ScriptedTurn[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      controller.enqueue(
        encoder.encode(
          sse("message_start", {
            type: "message_start",
            message: { id: "m1", role: "assistant", content: [], model: "claude-sonnet-4-6" },
          }),
        ),
      );
      let blockIndex = 0;
      for (const turn of turns) {
        if (turn.kind === "text") {
          controller.enqueue(
            encoder.encode(
              sse("content_block_start", {
                type: "content_block_start",
                index: blockIndex,
                content_block: { type: "text", text: "" },
              }),
            ),
          );
          controller.enqueue(
            encoder.encode(
              sse("content_block_delta", {
                type: "content_block_delta",
                index: blockIndex,
                delta: { type: "text_delta", text: turn.text },
              }),
            ),
          );
          controller.enqueue(
            encoder.encode(sse("content_block_stop", { type: "content_block_stop", index: blockIndex })),
          );
          blockIndex++;
        } else if (turn.kind === "tool_use") {
          if (turn.text) {
            controller.enqueue(
              encoder.encode(
                sse("content_block_start", {
                  type: "content_block_start",
                  index: blockIndex,
                  content_block: { type: "text", text: "" },
                }),
              ),
            );
            controller.enqueue(
              encoder.encode(
                sse("content_block_delta", {
                  type: "content_block_delta",
                  index: blockIndex,
                  delta: { type: "text_delta", text: turn.text },
                }),
              ),
            );
            controller.enqueue(
              encoder.encode(sse("content_block_stop", { type: "content_block_stop", index: blockIndex })),
            );
            blockIndex++;
          }
          controller.enqueue(
            encoder.encode(
              sse("content_block_start", {
                type: "content_block_start",
                index: blockIndex,
                content_block: { type: "tool_use", id: turn.id, name: turn.name, input: {} },
              }),
            ),
          );
          controller.enqueue(
            encoder.encode(
              sse("content_block_delta", {
                type: "content_block_delta",
                index: blockIndex,
                delta: { type: "input_json_delta", partial_json: JSON.stringify(turn.input) },
              }),
            ),
          );
          controller.enqueue(
            encoder.encode(sse("content_block_stop", { type: "content_block_stop", index: blockIndex })),
          );
          blockIndex++;
        }
      }
      // Faithful to the real API: a turn containing a tool_use stops for the
      // tool, not because the assistant finished.
      const stopReason = turns.some((t) => t.kind === "tool_use") ? "tool_use" : "end_turn";
      controller.enqueue(
        encoder.encode(sse("message_delta", { type: "message_delta", delta: { stop_reason: stopReason } })),
      );
      controller.enqueue(encoder.encode(sse("message_stop", { type: "message_stop" })));
      controller.close();
    },
  });
}
