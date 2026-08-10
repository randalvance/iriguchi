// SDK event shapes are normalized inside the gateway (see runner.ts) before
// being handed to translateSdkEvent. The runner adapts the actual Claude
// Agent SDK message stream into these neutral shapes.
export type SdkEvent =
  | { type: "stream_start" }
  | { type: "text_chunk"; text: string }
  | { type: "tool_use"; id?: string; name: string; input: unknown }
  | { type: "tool_result"; id?: string; result: unknown; is_error?: boolean }
  | { type: "done"; reason: "stop" | "max_turns" | "tool_failure" | "error" }
  | { type: "error"; message: string };

/**
 * A gateway extension: one tool invocation finished. Namespaced `iri_` like
 * `iri_agent` and `iri_context`, and carried on the delta because that is
 * where per-event data already lives, so a parser that does not know it walks
 * past it exactly as it walks past `tool_calls`.
 *
 * `id` is the call's own correlation id, so a client pairs a completion with
 * the `tool_calls` entry that produced it. Deliberately no payload: a page
 * only needs to know the call landed, and tool results can be large.
 */
export type IriToolResult = {
  id?: string;
  is_error: boolean;
};

export type OpenAIDelta = {
  role?: "assistant";
  content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  iri_tool_result?: IriToolResult;
};

export type OpenAIChoice = {
  index: number;
  delta: OpenAIDelta;
  finish_reason?: "stop" | "length" | "tool_calls" | "content_filter" | null;
};

export type OpenAIChunk = {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: OpenAIChoice[];
};

export type OpenAIFinishReason = NonNullable<OpenAIChoice["finish_reason"]>;

export type ChatCompletionToolCall = {
  id?: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatCompletionMessage = {
  role: "assistant";
  content: string;
  tool_calls?: ChatCompletionToolCall[];
};

export type ChatCompletion = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: ChatCompletionMessage;
    finish_reason: OpenAIFinishReason;
  }>;
};

export type TranslateContext = {
  id: string;
  created: number;
  model: string;
  showToolCalls: boolean;
  state: { nextToolIndex: number };
};

export function createTranslateContext(
  args: Omit<TranslateContext, "state">,
): TranslateContext {
  return { ...args, state: { nextToolIndex: 0 } };
}

function chunk(ctx: TranslateContext, choice: Partial<OpenAIChoice>): OpenAIChunk {
  return {
    id: ctx.id,
    object: "chat.completion.chunk",
    created: ctx.created,
    model: ctx.model,
    choices: [{ index: 0, delta: {}, ...choice } as OpenAIChoice],
  };
}

export function translateSdkEvent(ev: SdkEvent, ctx: TranslateContext): OpenAIChunk[] {
  switch (ev.type) {
    case "stream_start":
      ctx.state.nextToolIndex = 0;
      return [chunk(ctx, { delta: { role: "assistant", content: "" } })];
    case "text_chunk":
      if (!ev.text) return [];
      return [chunk(ctx, { delta: { content: ev.text } })];
    case "tool_use":
      if (!ctx.showToolCalls) return [];
      return [
        chunk(ctx, {
          delta: {
            tool_calls: [
              {
                index: ctx.state.nextToolIndex++,
                id: ev.id,
                type: "function",
                function: { name: ev.name, arguments: JSON.stringify(ev.input) },
              },
            ],
          },
        }),
      ];
    case "tool_result":
      // The result itself is for the model, not the client — only the fact
      // that the call finished goes on the wire, under the same switch as the
      // call. `ev.id` is the SDK's `tool_use_id` (runner.ts), the same id the
      // `tool_use` block carried, so a client pairs on id. Never on position:
      // parallel tool calls complete in whatever order they complete.
      if (!ctx.showToolCalls) return [];
      return [
        chunk(ctx, {
          delta: { iri_tool_result: { id: ev.id, is_error: ev.is_error === true } },
        }),
      ];
    case "done":
      return [
        chunk(ctx, {
          delta: {},
          finish_reason:
            ev.reason === "max_turns" ? "length" : ev.reason === "stop" ? "stop" : "stop",
        }),
      ];
    case "error":
      return [chunk(ctx, { delta: { content: `\n\n[gateway error: ${ev.message}]` } })];
  }
}

export function formatSseChunk(c: OpenAIChunk): string {
  return `data: ${JSON.stringify(c)}\n\n`;
}

export const DONE_SENTINEL = "data: [DONE]\n\n";

/**
 * Collapse a completed run's chunks into a single non-streaming
 * `chat.completion`. Pure, so the streaming and non-streaming responses are
 * provably derived from the same event sequence.
 *
 * `chunks` must be non-empty: the runner always emits a `stream_start` chunk
 * before any SDK work, so an empty drain is an internal invariant violation
 * rather than an empty result.
 */
export function aggregateChunks(chunks: OpenAIChunk[]): ChatCompletion {
  const first = chunks[0];
  if (!first) {
    throw new Error("aggregateChunks: cannot aggregate an empty chunk sequence");
  }

  let content = "";
  let finishReason: OpenAIFinishReason | null = null;
  // Keyed by delta index so partial tool calls accumulate correctly if the
  // translator ever splits arguments across chunks (today it does not).
  const toolCalls = new Map<number, ChatCompletionToolCall>();

  for (const chunk of chunks) {
    for (const choice of chunk.choices) {
      if (choice.delta.content) content += choice.delta.content;
      for (const call of choice.delta.tool_calls ?? []) {
        const existing = toolCalls.get(call.index);
        if (existing) {
          existing.id ??= call.id;
          if (call.function.name) existing.function.name = call.function.name;
          existing.function.arguments += call.function.arguments;
        } else {
          toolCalls.set(call.index, {
            id: call.id,
            type: "function",
            function: { name: call.function.name, arguments: call.function.arguments },
          });
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  }

  const message: ChatCompletionMessage = { role: "assistant", content };
  if (toolCalls.size > 0) {
    message.tool_calls = [...toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => call);
  }

  return {
    id: first.id,
    object: "chat.completion",
    created: first.created,
    model: first.model,
    choices: [{ index: 0, message, finish_reason: finishReason ?? "stop" }],
  };
}
