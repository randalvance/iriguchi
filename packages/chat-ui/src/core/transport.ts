import type { ChatMessage } from "./types.js";

/**
 * A failure the gateway (or the host's proxy route) reported as HTTP, before
 * the stream opened. `code` is the gateway's own error code when it sent one —
 * `context_too_large` and `invalid_context` are the ones a client can act on.
 */
export class ChatRequestError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = "ChatRequestError";
    this.status = status;
    this.code = code;
  }
}

/** Thrown when the caller aborted. The chat store reads the signal, not this. */
export class StreamAbortedError extends Error {
  constructor() {
    super("the run was aborted");
    this.name = "StreamAbortedError";
  }
}

export interface StreamRequest {
  endpoint: string;
  agent: string;
  messages: ChatMessage[];
  context?: Record<string, unknown> | undefined;
  model?: string | undefined;
  showToolCalls?: boolean | undefined;
  signal?: AbortSignal | undefined;
  fetchImpl?: typeof fetch | undefined;
}

/** One tool the agent invoked during the turn. */
export interface ToolCallEvent {
  /** The gateway's correlation id, matched by {@link ToolResultEvent.id}. */
  id?: string;
  name: string;
  /** The model's arguments, as the JSON string the gateway put on the wire. */
  arguments: string;
}

/**
 * One tool invocation finished. Carries no payload by design — the gateway
 * sends completion only, so a page learns that a write landed without the
 * tool's data passing through the browser.
 */
export interface ToolResultEvent {
  /** Pairs with the {@link ToolCallEvent} of the same id. Never by position. */
  id?: string;
  is_error: boolean;
}

export interface StreamHandlers {
  onDelta: (text: string) => void;
  onToolCall?: (call: ToolCallEvent) => void;
  onToolResult?: (result: ToolResultEvent) => void;
}

/** What actually goes on the wire. Nothing here is outside the gateway's contract. */
export function buildRequestBody(request: StreamRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    iri_agent: request.agent,
    // The gateway holds no session, so the whole conversation is resent.
    messages: request.messages.map(({ role, content }) => ({ role, content })),
    stream: true,
  };
  if (request.model !== undefined) body["model"] = request.model;
  if (request.context !== undefined) body["iri_context"] = request.context;
  // Omitted rather than sent as false, so the body a consumer who never asked
  // for tool events puts on the wire is unchanged.
  if (request.showToolCalls === true) body["iri_show_tool_calls"] = true;
  return body;
}

async function readError(response: Response): Promise<ChatRequestError> {
  let code: string | null = null;
  let message = `request failed with ${response.status}`;
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } };
      const error = parsed.error;
      if (typeof error?.code === "string") code = error.code;
      if (typeof error?.message === "string") message = error.message;
      else if (text.length > 0) message = text;
    } catch {
      if (text.length > 0) message = text;
    }
  } catch {
    // Body unreadable; the status alone is the whole story.
  }
  return new ChatRequestError(response.status, code, message);
}

/**
 * Applies a consumer handler without letting it take the stream down with it.
 * A page's refetch throwing is that page's problem; the turn still has text to
 * deliver.
 */
function safely(fn: (() => void) | undefined): void {
  if (fn === undefined) return;
  try {
    fn();
  } catch {
    // Swallowed on purpose: see above.
  }
}

/**
 * Reports whatever tool activity a chunk's delta carries. Anything that is not
 * the shape the gateway documents is skipped rather than raised — same policy
 * as the rest of this file.
 */
function reportToolEvents(delta: unknown, handlers: StreamHandlers): void {
  if (typeof delta !== "object" || delta === null) return;
  const { tool_calls: calls, iri_tool_result: result } = delta as {
    tool_calls?: unknown;
    iri_tool_result?: unknown;
  };

  if (handlers.onToolCall !== undefined && Array.isArray(calls)) {
    for (const entry of calls) {
      if (typeof entry !== "object" || entry === null) continue;
      const { id, function: fn } = entry as { id?: unknown; function?: unknown };
      if (typeof fn !== "object" || fn === null) continue;
      const { name, arguments: args } = fn as { name?: unknown; arguments?: unknown };
      if (typeof name !== "string" || name.length === 0) continue;
      const call: ToolCallEvent = {
        name,
        arguments: typeof args === "string" ? args : "",
      };
      if (typeof id === "string") call.id = id;
      safely(() => handlers.onToolCall?.(call));
    }
  }

  if (handlers.onToolResult !== undefined && typeof result === "object" && result !== null) {
    const { id, is_error: isError } = result as { id?: unknown; is_error?: unknown };
    const event: ToolResultEvent = { is_error: isError === true };
    if (typeof id === "string") event.id = id;
    safely(() => handlers.onToolResult?.(event));
  }
}

/** Pulls `data:` payloads out of one SSE event block. */
function dataOf(block: string): string | null {
  const parts: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("data:")) parts.push(line.slice(5).trimStart());
  }
  return parts.length === 0 ? null : parts.join("\n");
}

/**
 * POSTs the run and applies text deltas as they arrive. Unrecognized chunk
 * shapes are ignored rather than treated as failures — the gateway is free to
 * add fields, and a client that dies on one it has never seen is a client that
 * breaks on the next gateway release.
 */
export async function streamChatCompletion(
  request: StreamRequest,
  handlers: StreamHandlers,
): Promise<void> {
  const doFetch = request.fetchImpl ?? fetch;
  const response = await doFetch(request.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildRequestBody(request)),
    signal: request.signal ?? null,
  });

  if (!response.ok) throw await readError(response);
  if (response.body === null) {
    throw new ChatRequestError(response.status, null, "response carried no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Abort has to reach the reader, not just the request. Whether the fetch
  // itself rejects on abort depends on the runtime and on what sits between
  // here and the gateway, and a run the user stopped must stop either way.
  const onAbort = () => void reader.cancel().catch(() => {});
  request.signal?.addEventListener("abort", onAbort, { once: true });

  let finished = false;

  const drain = (flush: boolean) => {
    const blocks = buffer.split("\n\n");
    buffer = flush ? "" : (blocks.pop() ?? "");
    for (const block of blocks) {
      if (finished) return;
      const data = dataOf(block);
      if (data === null) continue;
      if (data === "[DONE]") {
        finished = true;
        return;
      }
      let chunk: unknown;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = (chunk as { choices?: Array<{ delta?: unknown }> }).choices?.[0]?.delta;
      const content = (delta as { content?: unknown } | undefined)?.content;
      if (typeof content === "string" && content.length > 0) handlers.onDelta(content);
      reportToolEvents(delta, handlers);
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (request.signal?.aborted === true) throw new StreamAbortedError();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      drain(false);
      if (finished) {
        await reader.cancel();
        return;
      }
    }
    drain(true);
  } finally {
    request.signal?.removeEventListener("abort", onAbort);
  }
}
