import { describe, it, expect } from "vitest";
import {
  translateSdkEvent,
  createTranslateContext,
  aggregateChunks,
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

  it("omits tool results by default", () => {
    const out = translateSdkEvent(
      { type: "tool_result", id: "tu_1", result: "sunny", is_error: false } as SdkEvent,
      makeCtx(),
    );
    expect(out).toEqual([]);
  });

  it("emits iri_tool_result when showToolCalls=true", () => {
    const out = translateSdkEvent(
      { type: "tool_result", id: "tu_1", result: "sunny", is_error: false } as SdkEvent,
      makeCtx({ showToolCalls: true }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].choices[0].delta.iri_tool_result).toEqual({ id: "tu_1", is_error: false });
  });

  it("pairs a result with its call by id", () => {
    const ctx = makeCtx({ showToolCalls: true });
    const call = translateSdkEvent(
      { type: "tool_use", id: "tu_7", name: "apply", input: {} } as SdkEvent,
      ctx,
    );
    const result = translateSdkEvent(
      { type: "tool_result", id: "tu_7", result: "ok", is_error: false } as SdkEvent,
      ctx,
    );
    expect(result[0].choices[0].delta.iri_tool_result?.id).toBe(
      call[0].choices[0].delta.tool_calls?.[0].id,
    );
  });

  it("reports a failed tool as is_error", () => {
    const out = translateSdkEvent(
      { type: "tool_result", id: "tu_1", result: { error: "boom" }, is_error: true } as SdkEvent,
      makeCtx({ showToolCalls: true }),
    );
    expect(out[0].choices[0].delta.iri_tool_result?.is_error).toBe(true);
  });

  it("never puts the tool's payload on the wire", () => {
    const out = translateSdkEvent(
      { type: "tool_result", id: "tu_1", result: { rows: ["secret-row"] } } as SdkEvent,
      makeCtx({ showToolCalls: true }),
    );
    expect(JSON.stringify(out)).not.toContain("secret-row");
  });

  it("defaults is_error to false when the event omits it", () => {
    const out = translateSdkEvent(
      { type: "tool_result", id: "tu_1", result: "ok" } as SdkEvent,
      makeCtx({ showToolCalls: true }),
    );
    expect(out[0].choices[0].delta.iri_tool_result?.is_error).toBe(false);
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

describe("flag-off compatibility", () => {
  it("a tool-invoking run streams the same bytes as before tool results existed", async () => {
    const { formatSseChunk, DONE_SENTINEL } = await import("../../src/agent/openai-sse.ts");
    const format = (events: SdkEvent[]) => {
      const ctx = makeCtx();
      return (
        events
          .flatMap((ev) => translateSdkEvent(ev, ctx))
          .map(formatSseChunk)
          .join("") + DONE_SENTINEL
      );
    };
    // With the flag off, a run that invokes a tool must put the same bytes on
    // the wire as the same run with its tool events elided — which is exactly
    // what a client saw before this change.
    const withTools = format([
      { type: "stream_start" },
      { type: "tool_use", id: "t1", name: "apply", input: { rows: 2 } },
      { type: "tool_result", id: "t1", result: "ok", is_error: false },
      { type: "text_chunk", text: "Categorized 2 rows." },
      { type: "done", reason: "stop" },
    ]);
    const textOnly = format([
      { type: "stream_start" },
      { type: "text_chunk", text: "Categorized 2 rows." },
      { type: "done", reason: "stop" },
    ]);
    expect(withTools).toBe(textOnly);
    expect(withTools).not.toContain("iri_tool_result");
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

describe("aggregateChunks", () => {
  /** Drive the real translator so the aggregator is tested against real chunks. */
  function run(events: SdkEvent[], showToolCalls = false): OpenAIChunk[] {
    const ctx = makeCtx({ showToolCalls });
    return events.flatMap((ev) => translateSdkEvent(ev, ctx));
  }

  it("concatenates text deltas in emission order", () => {
    const chunks = run([
      { type: "stream_start" },
      { type: "text_chunk", text: "Hello" },
      { type: "text_chunk", text: ", " },
      { type: "text_chunk", text: "world" },
      { type: "done", reason: "stop" },
    ]);
    const completion = aggregateChunks(chunks);
    expect(completion.choices[0].message.content).toBe("Hello, world");
    expect(completion.choices[0].message.role).toBe("assistant");
    expect(chunkContent(chunks)).toBe(completion.choices[0].message.content);
  });

  it("carries the identity fields of the first chunk", () => {
    const completion = aggregateChunks(
      run([{ type: "stream_start" }, { type: "done", reason: "stop" }]),
    );
    expect(completion.id).toBe("chatcmpl-01H");
    expect(completion.created).toBe(1717200000);
    expect(completion.model).toBe("claude-sonnet-4-6");
    expect(completion.object).toBe("chat.completion");
    expect(completion.choices).toHaveLength(1);
    expect(completion.choices[0].index).toBe(0);
  });

  it("yields empty content for a run with no text deltas", () => {
    const completion = aggregateChunks(
      run([{ type: "stream_start" }, { type: "done", reason: "stop" }]),
    );
    expect(completion.choices[0].message.content).toBe("");
  });

  it("passes through the terminal finish_reason", () => {
    expect(
      aggregateChunks(run([{ type: "stream_start" }, { type: "done", reason: "stop" }]))
        .choices[0].finish_reason,
    ).toBe("stop");
    expect(
      aggregateChunks(run([{ type: "stream_start" }, { type: "done", reason: "max_turns" }]))
        .choices[0].finish_reason,
    ).toBe("length");
  });

  it("defaults finish_reason to stop when no chunk carries one", () => {
    const completion = aggregateChunks(
      run([{ type: "stream_start" }, { type: "text_chunk", text: "hi" }]),
    );
    expect(completion.choices[0].finish_reason).toBe("stop");
  });

  it("collects tool calls in invocation order when shown", () => {
    const completion = aggregateChunks(
      run(
        [
          { type: "stream_start" },
          { type: "tool_use", id: "t1", name: "get_forecast", input: { location: "Tokyo" } },
          { type: "tool_result", id: "t1", result: "sunny" },
          { type: "tool_use", id: "t2", name: "get_alerts", input: { region: "JP" } },
          { type: "done", reason: "stop" },
        ],
        true,
      ),
    );
    const calls = completion.choices[0].message.tool_calls;
    expect(calls).toHaveLength(2);
    expect(calls?.map((c) => c.function.name)).toEqual(["get_forecast", "get_alerts"]);
    expect(calls?.map((c) => c.id)).toEqual(["t1", "t2"]);
    expect(calls?.[0].type).toBe("function");
    expect(JSON.parse(calls![0].function.arguments)).toEqual({ location: "Tokyo" });
  });

  it("omits tool_calls when the run made none", () => {
    const completion = aggregateChunks(
      run([{ type: "stream_start" }, { type: "text_chunk", text: "hi" }, { type: "done", reason: "stop" }]),
    );
    expect(completion.choices[0].message).not.toHaveProperty("tool_calls");
  });

  it("omits tool_calls when tool visibility is off", () => {
    const completion = aggregateChunks(
      run([
        { type: "stream_start" },
        { type: "tool_use", id: "t1", name: "get_forecast", input: {} },
        { type: "done", reason: "stop" },
      ]),
    );
    expect(completion.choices[0].message).not.toHaveProperty("tool_calls");
  });

  it("accumulates arguments split across chunks for the same index", () => {
    const base = { id: "chatcmpl-01H", object: "chat.completion.chunk" as const, created: 0, model: "m" };
    const completion = aggregateChunks([
      {
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "t1", type: "function", function: { name: "f", arguments: '{"a":' } },
              ],
            },
          },
        ],
      },
      {
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, type: "function", function: { name: "", arguments: "1}" } },
              ],
            },
          },
        ],
      },
    ]);
    const calls = completion.choices[0].message.tool_calls;
    expect(calls).toHaveLength(1);
    expect(calls?.[0].id).toBe("t1");
    expect(calls?.[0].function.name).toBe("f");
    expect(JSON.parse(calls![0].function.arguments)).toEqual({ a: 1 });
  });

  it("is unchanged by the presence of iri_tool_result chunks", () => {
    // The aggregator reads `content` and `tool_calls` and ignores everything
    // else; this is the assertion behind "provably derived from the same
    // event sequence" now that the stream carries a third kind of delta.
    const events: SdkEvent[] = [
      { type: "stream_start" },
      { type: "tool_use", id: "t1", name: "apply", input: { rows: 2 } },
      { type: "text_chunk", text: "done." },
      { type: "done", reason: "stop" },
    ];
    const withResults = run(
      [
        ...events.slice(0, 2),
        { type: "tool_result", id: "t1", result: "ok", is_error: false },
        ...events.slice(2),
      ],
      true,
    );
    const withoutResults = run(events, true);
    expect(aggregateChunks(withResults)).toEqual(aggregateChunks(withoutResults));
  });

  it("throws on an empty chunk sequence", () => {
    expect(() => aggregateChunks([])).toThrow(/empty chunk sequence/);
  });
});
