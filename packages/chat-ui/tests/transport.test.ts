import { describe, expect, it, vi } from "vitest";
import {
  buildRequestBody,
  ChatRequestError,
  streamChatCompletion,
  type ToolCallEvent,
  type ToolResultEvent,
} from "../src/core/transport.js";
import {
  chunk,
  controlledStream,
  deltaChunk,
  DONE,
  rejection,
  sseResponse,
  toolCallChunk,
  toolResultChunk,
} from "./helpers.js";

const base = { endpoint: "/api/ask-ai", agent: "weather-bot" };

function collect() {
  const seen: string[] = [];
  return { seen, handlers: { onDelta: (text: string) => seen.push(text) } };
}

describe("request body", () => {
  it("carries the agent, the whole history, and streaming", () => {
    const body = buildRequestBody({
      ...base,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "and now?" },
      ],
    });

    expect(body).toEqual({
      iri_agent: "weather-bot",
      stream: true,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "and now?" },
      ],
    });
  });

  it("omits iri_context when there is none", () => {
    const body = buildRequestBody({ ...base, messages: [], context: undefined });
    expect("iri_context" in body).toBe(false);
  });

  it("includes iri_context when there is one", () => {
    const body = buildRequestBody({ ...base, messages: [], context: { route: "/" } });
    expect(body["iri_context"]).toEqual({ route: "/" });
  });

  it("sends nothing describing client-executed actions", () => {
    const body = buildRequestBody({ ...base, messages: [], context: { route: "/" } });
    // Phase A is read-only: the request must be indistinguishable from one
    // produced by a client that has no notion of actions.
    expect(Object.keys(body).sort()).toEqual(["iri_agent", "iri_context", "messages", "stream"]);
  });

  it("strips per-turn status from the messages it sends", () => {
    const body = buildRequestBody({
      ...base,
      messages: [{ role: "assistant", content: "partial", status: "cancelled" }],
    });
    expect(body["messages"]).toEqual([{ role: "assistant", content: "partial" }]);
  });
});

describe("streaming", () => {
  it("emits deltas as they arrive and stops at [DONE]", async () => {
    const { seen, handlers } = collect();
    const fetchImpl = vi.fn(async () =>
      sseResponse([chunk("Hello"), chunk(" there"), DONE, chunk("ignored")]),
    );

    await streamChatCompletion({ ...base, messages: [], fetchImpl }, handlers);

    // Anything after the sentinel is not part of the run.
    expect(seen).toEqual(["Hello", " there"]);
  });

  it("tolerates chunks carrying fields it does not know", async () => {
    const { seen, handlers } = collect();
    const exotic =
      `data: ${JSON.stringify({
        object: "chat.completion.chunk",
        iri_future_field: { anything: true },
        choices: [{ index: 0, delta: { content: "ok", tool_calls: [] }, logprobs: null }],
      })}\n\n`;
    const fetchImpl = vi.fn(async () => sseResponse([`event: ping\ndata: {}\n\n`, exotic, DONE]));

    await streamChatCompletion({ ...base, messages: [], fetchImpl }, handlers);

    expect(seen).toEqual(["ok"]);
  });

  it("survives a frame split across reads", async () => {
    const { seen, handlers } = collect();
    const frame = chunk("split");
    const fetchImpl = vi.fn(async () =>
      sseResponse([frame.slice(0, 12), frame.slice(12), DONE]),
    );

    await streamChatCompletion({ ...base, messages: [], fetchImpl }, handlers);

    expect(seen).toEqual(["split"]);
  });

  it("surfaces the gateway's code and message when it fails before the stream", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              type: "invalid_request_error",
              code: "context_too_large",
              message: "iri_context is 70000 bytes, limit is 65536",
            },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
    );

    const error = await rejection<ChatRequestError>(
      streamChatCompletion({ ...base, messages: [], fetchImpl }, { onDelta: () => {} }),
    );

    expect(error).toBeInstanceOf(ChatRequestError);
    expect(error.status).toBe(400);
    expect(error.code).toBe("context_too_large");
    expect(error.message).toContain("65536");
  });

  it("reports a non-JSON failure body rather than swallowing it", async () => {
    const fetchImpl = vi.fn(async () => new Response("upstream exploded", { status: 502 }));

    const error = await rejection<ChatRequestError>(
      streamChatCompletion({ ...base, messages: [], fetchImpl }, { onDelta: () => {} }),
    );

    expect(error.status).toBe(502);
    expect(error.code).toBeNull();
    expect(error.message).toContain("upstream exploded");
  });

  it("propagates a break that happens after tokens have arrived", async () => {
    const { seen, handlers } = collect();
    const stream = controlledStream();
    const fetchImpl = vi.fn(async () => stream.response);

    const run = streamChatCompletion({ ...base, messages: [], fetchImpl }, handlers);
    stream.push(chunk("partial"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    stream.fail(new Error("connection reset"));

    await expect(run).rejects.toThrow();
    expect(seen).toEqual(["partial"]);
  });

  it("passes the abort signal through to fetch", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      return sseResponse([DONE]);
    }) as unknown as typeof fetch;

    await streamChatCompletion(
      { ...base, messages: [], fetchImpl, signal: controller.signal },
      { onDelta: () => {} },
    );
  });
});

describe("tool events", () => {
  /** Records deltas and tool events in the single order they arrived in. */
  function collectAll() {
    const seen: string[] = [];
    return {
      seen,
      handlers: {
        onDelta: (text: string) => seen.push(`delta:${text}`),
        onToolCall: (call: ToolCallEvent) => seen.push(`call:${call.id}:${call.name}`),
        onToolResult: (result: ToolResultEvent) =>
          seen.push(`result:${result.id}:${result.is_error}`),
      },
    };
  }

  it("asks for tool visibility only when told to", () => {
    expect("iri_show_tool_calls" in buildRequestBody({ ...base, messages: [] })).toBe(false);
    expect(
      "iri_show_tool_calls" in buildRequestBody({ ...base, messages: [], showToolCalls: false }),
    ).toBe(false);
    expect(buildRequestBody({ ...base, messages: [], showToolCalls: true })).toMatchObject({
      iri_show_tool_calls: true,
    });
  });

  it("reports a call and then its result, in stream order", async () => {
    const { seen, handlers } = collectAll();
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        toolCallChunk("tu_1", "apply_categories", { rows: 2 }),
        toolResultChunk("tu_1"),
        chunk("Done."),
        DONE,
      ]),
    );

    await streamChatCompletion({ ...base, messages: [], fetchImpl }, handlers);

    expect(seen).toEqual([
      "call:tu_1:apply_categories",
      "result:tu_1:false",
      "delta:Done.",
    ]);
  });

  it("carries the call's arguments through verbatim", async () => {
    const calls: ToolCallEvent[] = [];
    const fetchImpl = vi.fn(async () =>
      sseResponse([toolCallChunk("tu_1", "apply", { rows: [1, 2] }), DONE]),
    );

    await streamChatCompletion(
      { ...base, messages: [], fetchImpl },
      { onDelta: () => {}, onToolCall: (c) => calls.push(c) },
    );

    expect(JSON.parse(calls[0]!.arguments)).toEqual({ rows: [1, 2] });
  });

  it("reports a failed tool as is_error", async () => {
    const { seen, handlers } = collectAll();
    const fetchImpl = vi.fn(async () => sseResponse([toolResultChunk("tu_1", true), DONE]));

    await streamChatCompletion({ ...base, messages: [], fetchImpl }, handlers);

    expect(seen).toEqual(["result:tu_1:true"]);
  });

  it("is harmless when the caller supplied only onDelta", async () => {
    const { seen, handlers } = collect();
    const fetchImpl = vi.fn(async () =>
      sseResponse([toolCallChunk("tu_1", "apply"), toolResultChunk("tu_1"), chunk("hi"), DONE]),
    );

    await streamChatCompletion({ ...base, messages: [], fetchImpl }, handlers);

    expect(seen).toEqual(["hi"]);
  });

  it("skips malformed tool entries and keeps processing the stream", async () => {
    const { seen, handlers } = collectAll();
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        deltaChunk({ tool_calls: "not-an-array" }),
        deltaChunk({ tool_calls: [null, 7, {}, { function: {} }, { function: { name: "" } }] }),
        deltaChunk({ iri_tool_result: "not-an-object" }),
        chunk("still here"),
        DONE,
      ]),
    );

    await streamChatCompletion({ ...base, messages: [], fetchImpl }, handlers);

    expect(seen).toEqual(["delta:still here"]);
  });

  it("reports an id-less call and result rather than dropping them", async () => {
    const calls: ToolCallEvent[] = [];
    const results: ToolResultEvent[] = [];
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        deltaChunk({ tool_calls: [{ index: 0, function: { name: "apply", arguments: "{}" } }] }),
        deltaChunk({ iri_tool_result: { is_error: false } }),
        DONE,
      ]),
    );

    await streamChatCompletion(
      { ...base, messages: [], fetchImpl },
      { onDelta: () => {}, onToolCall: (c) => calls.push(c), onToolResult: (r) => results.push(r) },
    );

    expect(calls).toEqual([{ name: "apply", arguments: "{}" }]);
    expect(results).toEqual([{ is_error: false }]);
  });

  it("does not let a throwing handler break the run", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async () =>
      sseResponse([toolResultChunk("tu_1"), chunk("after"), DONE]),
    );

    await streamChatCompletion(
      { ...base, messages: [], fetchImpl },
      {
        onDelta: (text) => seen.push(text),
        onToolResult: () => {
          throw new Error("the consumer's refetch blew up");
        },
      },
    );

    expect(seen).toEqual(["after"]);
  });
});
