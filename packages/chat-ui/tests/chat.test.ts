import { describe, expect, it, vi } from "vitest";
import { createChat, type ChatError } from "../src/core/chat.js";
import { loadThread, storageKey } from "../src/core/storage.js";
import { chunk, controlledStream, DONE, memoryStorage, sseResponse } from "./helpers.js";

function setup(
  responder: () => Promise<Response> | Response,
  options: Partial<Parameters<typeof createChat>[0]> = {},
) {
  const errors: ChatError[] = [];
  const storage = memoryStorage();
  const fetchImpl = vi.fn(async () => responder()) as unknown as typeof fetch;
  const chat = createChat({
    endpoint: "/api/ask-ai",
    agent: "weather-bot",
    storage,
    fetchImpl,
    onError: (error) => errors.push(error),
    ...options,
  });
  return { chat, errors, storage, fetchImpl };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("chat store", () => {
  it("streams a reply into the transcript and completes", async () => {
    const { chat } = setup(() => sseResponse([chunk("Sunny"), chunk(", 72°F."), DONE]));

    await chat.send("what's the weather?");

    expect(chat.getMessages()).toEqual([
      { role: "user", content: "what's the weather?", status: "complete" },
      { role: "assistant", content: "Sunny, 72°F.", status: "complete" },
    ]);
    expect(chat.isStreaming()).toBe(false);
  });

  it("shows partial text while the run is in flight", async () => {
    const stream = controlledStream();
    const { chat } = setup(() => stream.response);

    const run = chat.send("hello");
    await settle();
    stream.push(chunk("Thinking"));
    await settle();

    expect(chat.getMessages()[1]).toMatchObject({ content: "Thinking", status: "streaming" });
    expect(chat.isStreaming()).toBe(true);

    stream.push(DONE);
    stream.finish();
    await run;
    expect(chat.getMessages()[1]?.status).toBe("complete");
  });

  it("resends the whole history every turn", async () => {
    const { chat, fetchImpl } = setup(() => sseResponse([chunk("ok"), DONE]));

    await chat.send("one");
    await chat.send("two");

    const calls = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock
      .calls;
    const body = JSON.parse(String(calls[1]?.[1]?.body)) as { messages: unknown[] };
    expect(body.messages).toEqual([
      { role: "user", content: "one" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "two" },
    ]);
  });

  it("attaches freshly derived context and never reuses the previous turn's", async () => {
    const { chat, fetchImpl } = setup(() => sseResponse([chunk("ok"), DONE]));
    let route = "/city/tokyo";
    const unregister = chat.registry.register("route", () => route);

    await chat.send("one");
    route = "/city/london";
    await chat.send("two");
    unregister();
    await chat.send("three");

    const calls = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock
      .calls;
    const bodies = calls.map((call) => JSON.parse(String(call[1]?.body)) as Record<string, unknown>);
    expect(bodies[0]?.["iri_context"]).toEqual({ route: "/city/tokyo" });
    expect(bodies[1]?.["iri_context"]).toEqual({ route: "/city/london" });
    expect("iri_context" in (bodies[2] ?? {})).toBe(false);
  });

  it("keeps partial text and marks the turn cancelled when the user stops it", async () => {
    const stream = controlledStream();
    const { chat, errors } = setup(() => stream.response);

    const run = chat.send("tell me a long story");
    await settle();
    stream.push(chunk("Once upon"));
    await settle();
    chat.cancel();
    await run;

    expect(chat.getMessages()[1]).toMatchObject({
      content: "Once upon",
      status: "cancelled",
    });
    // Cancelling is not a failure and must not be reported as one.
    expect(errors).toEqual([]);
    expect(chat.isStreaming()).toBe(false);
  });

  it("carries cancelled partial text into the next turn's history", async () => {
    const stream = controlledStream();
    let first = true;
    const { chat, fetchImpl } = setup(() => {
      if (first) {
        first = false;
        return stream.response;
      }
      return sseResponse([chunk("ok"), DONE]);
    });

    const run = chat.send("start");
    await settle();
    stream.push(chunk("half a thought"));
    await settle();
    chat.cancel();
    await run;
    await chat.send("carry on");

    const calls = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock
      .calls;
    const body = JSON.parse(String(calls[1]?.[1]?.body)) as { messages: unknown[] };
    expect(body.messages).toContainEqual({ role: "assistant", content: "half a thought" });
  });

  it("replaces the pending turn with an error when the request fails before streaming", async () => {
    const { chat, errors } = setup(
      () =>
        new Response(
          JSON.stringify({ error: { code: "invalid_context", message: "not an object" } }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
    );

    await chat.send("hi");

    expect(chat.getMessages()[1]).toMatchObject({ content: "", status: "error" });
    expect(chat.getMessages()[1]?.error).toContain("invalid_context");
    expect(errors[0]?.phase).toBe("request");
  });

  it("keeps rendered text and appends the reason when the stream breaks", async () => {
    const stream = controlledStream();
    const { chat } = setup(() => stream.response);

    const run = chat.send("hi");
    await settle();
    stream.push(chunk("Partial answer"));
    await settle();
    stream.fail(new Error("connection reset"));
    await run;

    expect(chat.getMessages()[1]).toMatchObject({
      content: "Partial answer",
      status: "error",
    });
  });

  it("stays usable after a failure", async () => {
    let fail = true;
    const { chat } = setup(() => {
      if (fail) {
        fail = false;
        return new Response("boom", { status: 500 });
      }
      return sseResponse([chunk("recovered"), DONE]);
    });

    await chat.send("first");
    await chat.send("second");

    expect(chat.getMessages()).toHaveLength(4);
    expect(chat.getMessages()[3]).toMatchObject({ content: "recovered", status: "complete" });
  });

  it("refuses an oversized context before the network and names the slice", async () => {
    const { chat, errors, fetchImpl } = setup(() => sseResponse([DONE]), { maxContextBytes: 512 });
    chat.registry.register("rows", () =>
      Array.from({ length: 100 }, (_, i) => ({ id: i, note: "x".repeat(50) })),
    );

    await chat.send("summarize these");

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(chat.getMessages()[1]?.status).toBe("error");
    expect(errors[0]?.phase).toBe("context");
    expect(errors[0]?.message).toContain("rows");
  });

  it("reports a failing slice but still sends", async () => {
    const { chat, errors, fetchImpl } = setup(() => sseResponse([chunk("ok"), DONE]));
    chat.registry.register("route", () => "/city/tokyo");
    chat.registry.register("broken", () => {
      throw new Error("not ready");
    });

    await chat.send("hi");

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(errors[0]).toMatchObject({ phase: "slice", key: "broken" });
    const body = JSON.parse(
      String(
        (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock
          .calls[0]?.[1]?.body,
      ),
    ) as Record<string, unknown>;
    expect(body["iri_context"]).toEqual({ route: "/city/tokyo" });
  });

  it("persists across a rebuild and never persists context", async () => {
    const storage = memoryStorage();
    const { chat } = setup(() => sseResponse([chunk("Sunny"), DONE]), { storage });
    chat.registry.register("forecast", () => [{ day: 1, high_f: 70 }]);

    await chat.send("weather?");

    const raw = storage.getItem(storageKey("weather-bot")) ?? "";
    expect(raw).not.toContain("high_f");
    expect(loadThread("weather-bot", storage)).toEqual([
      { role: "user", content: "weather?" },
      { role: "assistant", content: "Sunny" },
    ]);

    const revived = createChat({ endpoint: "/api/ask-ai", agent: "weather-bot", storage });
    expect(revived.getMessages()).toHaveLength(2);
  });

  it("clears both the transcript and the stored thread", async () => {
    const { chat, storage } = setup(() => sseResponse([chunk("ok"), DONE]));

    await chat.send("hi");
    chat.clear();

    expect(chat.getMessages()).toEqual([]);
    expect(storage.getItem(storageKey("weather-bot"))).toBeNull();
  });

  it("ignores an empty message and a second send while one is in flight", async () => {
    const stream = controlledStream();
    const { chat, fetchImpl } = setup(() => stream.response);

    await chat.send("   ");
    expect(fetchImpl).not.toHaveBeenCalled();

    const run = chat.send("first");
    await settle();
    await chat.send("second");
    expect(fetchImpl).toHaveBeenCalledOnce();

    chat.cancel();
    await run;
  });

  it("counts as in flight while the context is still being derived", async () => {
    const { chat } = setup(() => sseResponse([chunk("ok"), DONE]));
    let release = () => {};
    chat.registry.register("slow", () => new Promise((resolve) => (release = () => resolve("v"))));

    const run = chat.send("hi");
    await settle();

    expect(chat.isStreaming()).toBe(true);

    release();
    await run;
    expect(chat.isStreaming()).toBe(false);
  });

  it("ignores a second send while a slow slice is still resolving", async () => {
    const { chat, fetchImpl } = setup(() => sseResponse([chunk("ok"), DONE]));
    let release = () => {};
    chat.registry.register("slow", () => new Promise((resolve) => (release = () => resolve("v"))));

    const run = chat.send("first");
    await settle();
    await chat.send("second");

    // Two concurrent runs would interleave their deltas into whichever turn
    // happened to be last, so the guard has to cover this window too.
    expect(chat.getMessages().map((message) => message.content)).toEqual(["first", ""]);

    release();
    await run;
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(chat.getMessages()).toHaveLength(2);
  });

  it("cancels before dispatch when stopped while slices are resolving", async () => {
    const { chat, errors, fetchImpl } = setup(() => sseResponse([chunk("ok"), DONE]));
    let release = () => {};
    chat.registry.register("slow", () => new Promise((resolve) => (release = () => resolve("v"))));

    const run = chat.send("hi");
    await settle();
    chat.cancel();
    release();
    await run;

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(chat.getMessages()[1]).toMatchObject({ content: "", status: "cancelled" });
    expect(errors).toEqual([]);
    expect(chat.isStreaming()).toBe(false);
  });

  it("accepts a new send after a cancel that landed during resolution", async () => {
    const { chat, fetchImpl } = setup(() => sseResponse([chunk("ok"), DONE]));
    let release = () => {};
    const unregister = chat.registry.register(
      "slow",
      () => new Promise((resolve) => (release = () => resolve("v"))),
    );

    const first = chat.send("hi");
    await settle();
    chat.cancel();
    release();
    await first;

    unregister();
    await chat.send("again");

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(chat.getMessages()[3]).toMatchObject({ content: "ok", status: "complete" });
  });

  it("notifies subscribers and stops after unsubscribe", async () => {
    const { chat } = setup(() => sseResponse([chunk("ok"), DONE]));
    const listener = vi.fn();
    const unsubscribe = chat.subscribe(listener);

    await chat.send("hi");
    const seen = listener.mock.calls.length;
    expect(seen).toBeGreaterThan(0);

    unsubscribe();
    await chat.send("again");
    expect(listener.mock.calls.length).toBe(seen);
  });
});
