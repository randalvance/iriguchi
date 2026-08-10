import { buildContext, ContextTooLargeError, resolveSlices } from "./context.js";
import { SliceRegistry } from "./registry.js";
import {
  clearThread,
  defaultStorage,
  loadThread,
  saveThread,
  type StorageLike,
  type StorageLimits,
} from "./storage.js";
import {
  ChatRequestError,
  streamChatCompletion,
  type ToolCallEvent,
  type ToolResultEvent,
} from "./transport.js";
import type { ChatMessage, SliceFailure, TruncationNotice } from "./types.js";

export type ChatErrorPhase = "slice" | "context" | "request";

export interface ChatError {
  phase: ChatErrorPhase;
  message: string;
  cause: unknown;
  /** Set when the failure belongs to one slice. */
  key?: string;
}

/**
 * A tool the agent invoked, or the news that one finished. Handed to whatever
 * subscribed through {@link Chat.subscribeToolEvents} — the panel does not
 * render any of this.
 */
export type ToolEvent =
  | ({ type: "call" } & ToolCallEvent)
  | ({ type: "result" } & ToolResultEvent);

export type ToolEventHandler = (event: ToolEvent) => void;

export interface ChatOptions {
  /** The host's own route, never the gateway — the key stays server-side. */
  endpoint: string;
  agent: string;
  model?: string;
  /**
   * Ask the gateway to report the run's tool activity, delivered through
   * `subscribeToolEvents`. Off by default, and when off the request body is
   * unchanged from a client that has no notion of tool events.
   */
  showToolCalls?: boolean;
  maxContextBytes?: number;
  sliceTimeoutMs?: number;
  storage?: StorageLike | null;
  storageLimits?: StorageLimits;
  fetchImpl?: typeof fetch;
  onError?: (error: ChatError) => void;
  onTruncate?: (notice: TruncationNotice) => void;
}

export interface Chat {
  readonly registry: SliceRegistry;
  getMessages(): readonly ChatMessage[];
  isStreaming(): boolean;
  subscribe(listener: () => void): () => void;
  /**
   * Observe the run's tool activity as it happens — a page waiting on a write
   * refetches when the result lands, not when the model stops talking.
   * Delivers nothing unless the chat was created with `showToolCalls`.
   */
  subscribeToolEvents(handler: ToolEventHandler): () => void;
  send(text: string): Promise<void>;
  cancel(): void;
  clear(): void;
}

export function createChat(options: ChatOptions): Chat {
  const registry = new SliceRegistry();
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const listeners = new Set<() => void>();
  // Separate from `listeners`: those are store-changed notifications a
  // component re-renders on, these are one-shot facts about the run.
  const toolListeners = new Set<ToolEventHandler>();

  let messages: ChatMessage[] = loadThread(options.agent, storage).map((message) => ({
    ...message,
    status: "complete" as const,
  }));
  let controller: AbortController | null = null;

  const emit = () => {
    // A new array identity each time, so `useSyncExternalStore` and any other
    // reference-comparing consumer sees the change.
    messages = [...messages];
    for (const listener of listeners) listener();
  };
  const emitToolEvent = (event: ToolEvent) => {
    // One subscriber throwing must not cost the others their event, nor the
    // turn its remaining text. The transport guards this too; this guards the
    // fan-out between subscribers.
    for (const handler of toolListeners) {
      try {
        handler(event);
      } catch {
        // The consumer's problem, not the run's.
      }
    }
  };
  const persist = () => saveThread(options.agent, messages, storage, options.storageLimits);
  const report = (error: ChatError) => options.onError?.(error);

  const finish = (status: ChatMessage["status"], error?: string) => {
    const last = messages[messages.length - 1];
    if (last !== undefined && last.role === "assistant") {
      last.status = status;
      if (error !== undefined) last.error = error;
    }
    controller = null;
    emit();
    persist();
  };

  return {
    registry,

    getMessages: () => messages,
    isStreaming: () => controller !== null,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    subscribeToolEvents(handler) {
      toolListeners.add(handler);
      return () => void toolListeners.delete(handler);
    },

    async send(text) {
      const trimmed = text.trim();
      if (trimmed.length === 0 || controller !== null) return;

      // Claimed before anything is awaited. A send is in flight from the
      // moment it is asked for, including while the context is being derived:
      // this is what blocks a second send, what makes the composer show Stop,
      // and what gives cancel() something to abort during that window.
      controller = new AbortController();
      const signal = controller.signal;

      messages.push({ role: "user", content: trimmed, status: "complete" });
      messages.push({ role: "assistant", content: "", status: "streaming" });
      emit();
      persist();

      // Derived fresh, every send: the envelope describes the page as it is
      // right now, and is never carried over from the previous turn.
      const slices = await resolveSlices(registry, {
        timeoutMs: options.sliceTimeoutMs,
        onFailure: (failure: SliceFailure) =>
          report({
            phase: "slice",
            key: failure.key,
            message: `context slice "${failure.key}" ${failure.reason === "timeout" ? "timed out" : "failed"} and was omitted`,
            cause: failure.cause,
          }),
      });

      // Cancelled while slices were resolving: the run stops here, before it
      // ever reaches the gateway. Slice callbacks take no signal, so any still
      // outstanding settle into nothing.
      if (signal.aborted) {
        finish("cancelled");
        return;
      }

      let context: Record<string, unknown> | undefined;
      try {
        context = buildContext(slices, {
          maxBytes: options.maxContextBytes,
          onTruncate: options.onTruncate,
        });
      } catch (cause) {
        const message =
          cause instanceof ContextTooLargeError ? cause.message : "failed to assemble iri_context";
        report({ phase: "context", message, cause });
        finish("error", message);
        return;
      }

      try {
        await streamChatCompletion(
          {
            endpoint: options.endpoint,
            agent: options.agent,
            messages: messages.slice(0, -1),
            context,
            model: options.model,
            showToolCalls: options.showToolCalls,
            signal,
            fetchImpl: options.fetchImpl,
          },
          {
            onDelta: (delta) => {
              const last = messages[messages.length - 1];
              if (last !== undefined) last.content += delta;
              emit();
            },
            onToolCall: (call) => emitToolEvent({ type: "call", ...call }),
            onToolResult: (result) => emitToolEvent({ type: "result", ...result }),
          },
        );
        finish("complete");
      } catch (cause) {
        // The user asking for it is not a failure, and must not be styled as one.
        if (signal.aborted) {
          finish("cancelled");
          return;
        }
        const message =
          cause instanceof ChatRequestError
            ? cause.code === null
              ? cause.message
              : `${cause.code}: ${cause.message}`
            : cause instanceof Error
              ? cause.message
              : String(cause);
        report({ phase: "request", message, cause });
        // Whatever already rendered stays: the user can still see it, and
        // deleting it would leave the transcript contradicting the screen.
        finish("error", message);
      }
    },

    cancel() {
      controller?.abort();
    },

    clear() {
      controller?.abort();
      messages = [];
      emit();
      clearThread(options.agent, storage);
    },
  };
}
