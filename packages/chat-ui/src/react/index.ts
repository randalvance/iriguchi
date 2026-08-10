import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  createChat,
  type Chat,
  type ChatOptions,
  type ToolEvent,
  type ToolEventHandler,
} from "../core/chat.js";
import type { ChatMessage, ContextCallback, ContextSliceOptions } from "../core/types.js";

const ChatContext = createContext<Chat | null>(null);

export interface IriguchiChatProviderProps extends Omit<ChatOptions, "endpoint" | "agent"> {
  /** The host's own proxy route — not the gateway. */
  endpoint: string;
  agent: string;
  /**
   * Ask the gateway to report tool activity, observed with
   * {@link useIriToolEvents}.
   *
   * Effectively mount-time: the chat is rebuilt only when `endpoint` or
   * `agent` change, so flipping this afterwards has no effect. That is the
   * right trade — rebuilding would drop the conversation.
   */
  showToolCalls?: boolean;
  children?: ReactNode;
}

export function IriguchiChatProvider(props: IriguchiChatProviderProps) {
  const { children, ...options } = props;

  // Keyed on endpoint and agent only. Rebuilding the chat on any other prop
  // change would drop the conversation, which a re-render must never do.
  const chat = useMemo(
    () => createChat(options as ChatOptions),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [options.endpoint, options.agent],
  );

  return createElement(ChatContext.Provider, { value: chat }, children);
}

export function useIriguchiChatInstance(): Chat {
  const chat = useContext(ChatContext);
  if (chat === null) {
    throw new Error("useIriChat must be used inside an <IriguchiChatProvider>");
  }
  return chat;
}

/**
 * Registers one top-level key of `iri_context`, supplied by whichever
 * component actually owns the data. The callback is read through a ref, so a
 * new closure on every render does not churn the registration — only mount and
 * unmount do.
 */
export function useIriContext(
  key: string,
  callback: ContextCallback,
  options: ContextSliceOptions = {},
): void {
  const chat = useIriguchiChatInstance();
  const latest = useRef(callback);
  latest.current = callback;

  const truncate = options.truncate;
  const timeoutMs = options.timeoutMs;

  useEffect(() => {
    return chat.registry.register(key, () => latest.current(), { truncate, timeoutMs });
  }, [chat, key, truncate, timeoutMs]);
}

/**
 * Observes the run's tool activity: one `call` event per tool the agent
 * invoked, then one `result` event when it finishes, pairable by `id`.
 *
 * For the page that owns the data a tool just wrote — it refetches on the
 * result rather than waiting for the model to stop talking. Registration is
 * per-consumer and needs nothing from the app root; the handler is read
 * through a ref, so a new closure each render does not churn it.
 *
 * Silent unless the provider was given `showToolCalls`.
 */
export function useIriToolEvents(handler: ToolEventHandler): void {
  const chat = useIriguchiChatInstance();
  const latest = useRef(handler);
  latest.current = handler;

  useEffect(() => chat.subscribeToolEvents((event) => latest.current(event)), [chat]);
}

export interface UseIriChat {
  messages: readonly ChatMessage[];
  streaming: boolean;
  send: (text: string) => Promise<void>;
  cancel: () => void;
  clear: () => void;
}

export function useIriChat(): UseIriChat {
  const chat = useIriguchiChatInstance();
  const messages = useSyncExternalStore(
    (listener) => chat.subscribe(listener),
    () => chat.getMessages(),
    () => chat.getMessages(),
  );
  const streaming = useSyncExternalStore(
    (listener) => chat.subscribe(listener),
    () => chat.isStreaming(),
    () => false,
  );

  return {
    messages,
    streaming,
    send: (text: string) => chat.send(text),
    cancel: () => chat.cancel(),
    clear: () => chat.clear(),
  };
}

export type { Chat, ChatOptions, ChatError, ToolEvent, ToolEventHandler } from "../core/chat.js";
export type { ToolCallEvent, ToolResultEvent } from "../core/transport.js";
export type { ChatMessage, TurnStatus } from "../core/types.js";
