import { describe, expect, it, vi } from "vitest";
import {
  buildRequestBody,
  ChatRequestError,
  streamChatCompletion,
} from "../src/core/transport.js";
import { chunk, controlledStream, DONE, rejection, sseResponse } from "./helpers.js";

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
