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

export type OpenAIDelta = {
  role?: "assistant";
  content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
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

export type TranslateContext = {
  id: string;
  created: number;
  model: string;
  showToolCalls: boolean;
};

let nextToolIndex = 0; // module-local; runner resets per-request via newToolIndex

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
      nextToolIndex = 0;
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
                index: nextToolIndex++,
                id: ev.id,
                type: "function",
                function: { name: ev.name, arguments: JSON.stringify(ev.input) },
              },
            ],
          },
        }),
      ];
    case "tool_result":
      // Tool results are fed back to the LLM; clients see only the model's
      // next text turn. Nothing emitted to OpenAI stream.
      return [];
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
