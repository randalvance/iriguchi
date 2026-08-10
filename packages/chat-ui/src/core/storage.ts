import type { ChatMessage } from "./types.js";

/**
 * Bumped whenever the stored shape changes. A thread written under a different
 * version is dropped rather than migrated — losing a conversation is a much
 * smaller harm than a panel that cannot mount.
 */
export const STORAGE_VERSION = 1;

export const DEFAULT_MAX_STORED_MESSAGES = 40;
export const DEFAULT_MAX_STORED_BYTES = 131072;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface StorageLimits {
  maxMessages?: number;
  maxBytes?: number;
}

export function storageKey(agent: string): string {
  return `iriguchi.chat.v${STORAGE_VERSION}.${agent}`;
}

/** `localStorage` is absent under SSR and throws outright in some privacy modes. */
export function defaultStorage(): StorageLike | null {
  try {
    const candidate = (globalThis as { localStorage?: StorageLike }).localStorage;
    return candidate ?? null;
  } catch {
    return null;
  }
}

function isMessage(value: unknown): value is ChatMessage {
  const message = value as { role?: unknown; content?: unknown };
  return (
    typeof message === "object" &&
    message !== null &&
    (message.role === "user" || message.role === "assistant") &&
    typeof message.content === "string"
  );
}

export function loadThread(agent: string, storage: StorageLike | null): ChatMessage[] {
  if (storage === null) return [];
  let raw: string | null;
  try {
    raw = storage.getItem(storageKey(agent));
  } catch {
    return [];
  }
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as { v?: unknown; messages?: unknown };
    if (parsed.v !== STORAGE_VERSION || !Array.isArray(parsed.messages)) return [];
    if (!parsed.messages.every(isMessage)) return [];
    return parsed.messages.map((message) => ({ role: message.role, content: message.content }));
  } catch {
    return [];
  }
}

/**
 * Applies both caps, oldest first. Both are needed: a handful of long
 * assistant turns exhausts the byte budget without approaching the count.
 * Only role and content are written — never context, and never a slice value.
 */
export function capMessages(messages: ChatMessage[], limits: StorageLimits = {}): ChatMessage[] {
  const maxMessages = limits.maxMessages ?? DEFAULT_MAX_STORED_MESSAGES;
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_STORED_BYTES;
  const encoder = new TextEncoder();

  let kept = messages
    .slice(-maxMessages)
    .map((message) => ({ role: message.role, content: message.content }));

  while (
    kept.length > 0 &&
    encoder.encode(JSON.stringify({ v: STORAGE_VERSION, messages: kept })).length > maxBytes
  ) {
    kept = kept.slice(1);
  }
  return kept;
}

export function saveThread(
  agent: string,
  messages: ChatMessage[],
  storage: StorageLike | null,
  limits: StorageLimits = {},
): void {
  if (storage === null) return;
  try {
    storage.setItem(
      storageKey(agent),
      JSON.stringify({ v: STORAGE_VERSION, messages: capMessages(messages, limits) }),
    );
  } catch {
    // Quota exhausted, storage disabled mid-session, serialization refused —
    // none of which is a reason to break the panel for the rest of the session.
  }
}

export function clearThread(agent: string, storage: StorageLike | null): void {
  if (storage === null) return;
  try {
    storage.removeItem(storageKey(agent));
  } catch {
    // As above.
  }
}
