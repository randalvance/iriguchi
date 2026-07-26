import { describe, it, expect } from "bun:test";
import {
  translateSdkEvent,
  createTranslateContext,
  type OpenAIChunk,
  type SdkEvent,
} from "../../src/agent/openai-sse.ts";

function makeCtx(overrides: Partial<{ showToolCalls: boolean }> = {}) {
  return createTranslateContext({
    id: "chatcmpl-01H",
    created: 1717200000,
    model: "claude-sonnet-4-6",
    showToolCalls: false,
    ...overrides,
  });
}

function chunkContent(chunks: OpenAIChunk[]): string {
  return chunks
    .flatMap((c) => c.choices.map((ch) => ch.delta.content || ""))
    .join("");
}

describe("translateSdkEvent", () => {
  it("emits role-only delta as the first chunk on stream_start", () => {
    const ctx = makeCtx();
    const out = translateSdkEvent({ type: "stream_start" } as SdkEvent, ctx);
    expect(out).toHaveLength(1);
    expect(out[0].choices[0].delta).toEqual({ role: "assistant", content: "" });
    expect(out[0].id).toBe(ctx.id);
    expect(out[0].model).toBe(ctx.model);
    expect(out[0].object).toBe("chat.completion.chunk");
  });

  it("emits content delta on text_chunk", () => {
    const out = translateSdkEvent(
      { type: "text_chunk", text: "Hello" } as SdkEvent,
      makeCtx(),
    );
    expect(out).toHaveLength(1);
    expect(out[0].choices[0].delta).toEqual({ content: "Hello" });
  });

  it("aggregated text matches the source events", () => {
    const events: SdkEvent[] = [
      { type: "stream_start" },
      { type: "text_chunk", text: "Hello " },
      { type: "text_chunk", text: "world." },
    ];
    const chunks = events.flatMap((e) => translateSdkEvent(e, makeCtx()));
    expect(chunkContent(chunks)).toBe("Hello world.");
  });

  it("omits tool calls by default", () => {
    const out = translateSdkEvent(
      { type: "tool_use", name: "get_forecast", input: { location: "NYC" } } as SdkEvent,
      makeCtx(),
    );
    expect(out).toEqual([]);
  });

  it("emits tool_calls delta when showToolCalls=true", () => {
    const out = translateSdkEvent(
      { type: "tool_use", id: "tu_1", name: "get_forecast", input: { location: "NYC" } } as SdkEvent,
      makeCtx({ showToolCalls: true }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].choices[0].delta.tool_calls?.[0]).toEqual({
      index: 0,
      id: "tu_1",
      type: "function",
      function: { name: "get_forecast", arguments: '{"location":"NYC"}' },
    });
  });

  it("emits finish chunk on done", () => {
    const out = translateSdkEvent({ type: "done", reason: "stop" } as SdkEvent, makeCtx());
    expect(out).toHaveLength(1);
    expect(out[0].choices[0].finish_reason).toBe("stop");
    expect(out[0].choices[0].delta).toEqual({});
  });

  it("maps max_turns reason to length", () => {
    const out = translateSdkEvent(
      { type: "done", reason: "max_turns" } as SdkEvent,
      makeCtx(),
    );
    expect(out[0].choices[0].finish_reason).toBe("length");
  });

  it("emits error system delta on error event", () => {
    const out = translateSdkEvent(
      { type: "error", message: "boom" } as SdkEvent,
      makeCtx(),
    );
    expect(out).toHaveLength(1);
    expect(out[0].choices[0].delta.content).toContain("boom");
  });

  it("two concurrent contexts do not cross-contaminate tool_call indices", () => {
    const a = makeCtx({ showToolCalls: true });
    const b = makeCtx({ showToolCalls: true });
    // interleave: a tool, b tool, a tool, b tool
    const a1 = translateSdkEvent({ type: "tool_use", id: "a1", name: "n", input: {} }, a);
    const b1 = translateSdkEvent({ type: "tool_use", id: "b1", name: "n", input: {} }, b);
    const a2 = translateSdkEvent({ type: "tool_use", id: "a2", name: "n", input: {} }, a);
    const b2 = translateSdkEvent({ type: "tool_use", id: "b2", name: "n", input: {} }, b);
    expect(a1[0].choices[0].delta.tool_calls?.[0].index).toBe(0);
    expect(a2[0].choices[0].delta.tool_calls?.[0].index).toBe(1);
    expect(b1[0].choices[0].delta.tool_calls?.[0].index).toBe(0);
    expect(b2[0].choices[0].delta.tool_calls?.[0].index).toBe(1);
  });
});

describe("DONE sentinel formatting", () => {
  it("the gateway encodes done as 'data: [DONE]'", async () => {
    const { formatSseChunk, DONE_SENTINEL } = await import(
      "../../src/agent/openai-sse.ts"
    );
    expect(formatSseChunk({ id: "x", object: "chat.completion.chunk", created: 0, model: "m", choices: [] })).toContain("data: ");
    expect(DONE_SENTINEL).toBe("data: [DONE]\n\n");
  });
});
