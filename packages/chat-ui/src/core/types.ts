export type ChatRole = "user" | "assistant";

/**
 * A turn's lifecycle. `cancelled` is deliberately not a kind of `error`: the
 * user asked for it, and the panel must not dress it up as a failure.
 */
export type TurnStatus = "streaming" | "complete" | "cancelled" | "error";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  status?: TurnStatus;
  /** Present only when `status` is `error`. */
  error?: string;
}

export type ContextValue = unknown;
export type ContextCallback = () => ContextValue | Promise<ContextValue>;

export interface ContextSliceOptions {
  /**
   * Allow this slice to be shortened when the merged context would exceed the
   * size limit. Only array values can be truncated — silently shortening an
   * object is worse than refusing to send.
   */
  truncate?: boolean;
  /** Overrides the chat-level slice resolution timeout. */
  timeoutMs?: number;
}

/**
 * Registrations carry a kind so a later change can add client-executed actions
 * to the same registry without altering how context slices are registered.
 * Nothing but "context" exists today, and nothing but context reaches the wire.
 */
export interface ContextRegistration {
  kind: "context";
  key: string;
  callback: ContextCallback;
  options: ContextSliceOptions;
}

export type Registration = ContextRegistration;

/** How a slice failed to contribute, reported through the chat's `onError`. */
export interface SliceFailure {
  key: string;
  reason: "threw" | "timeout";
  cause: unknown;
}

export interface TruncationNotice {
  key: string;
  total: number;
  kept: number;
}
