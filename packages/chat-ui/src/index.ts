export { createChat } from "./core/chat.js";
export type { Chat, ChatError, ChatErrorPhase, ChatOptions } from "./core/chat.js";
export {
  buildContext,
  ContextTooLargeError,
  DEFAULT_MAX_CONTEXT_BYTES,
  DEFAULT_SLICE_TIMEOUT_MS,
  resolveSlices,
  serializedSize,
} from "./core/context.js";
export { SliceRegistry } from "./core/registry.js";
export {
  clearThread,
  loadThread,
  saveThread,
  storageKey,
  STORAGE_VERSION,
} from "./core/storage.js";
export type { StorageLike, StorageLimits } from "./core/storage.js";
export { buildRequestBody, ChatRequestError, streamChatCompletion } from "./core/transport.js";
export type {
  ChatMessage,
  ChatRole,
  ContextCallback,
  ContextRegistration,
  ContextSliceOptions,
  Registration,
  SliceFailure,
  TruncationNotice,
  TurnStatus,
} from "./core/types.js";
