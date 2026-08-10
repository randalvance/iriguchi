import type { SliceRegistry } from "./registry.js";
import type {
  ContextSliceOptions,
  ContextValue,
  SliceFailure,
  TruncationNotice,
} from "./types.js";

/** The gateway's own default for `IRI_MAX_CONTEXT_BYTES`. */
export const DEFAULT_MAX_CONTEXT_BYTES = 65536;
export const DEFAULT_SLICE_TIMEOUT_MS = 5000;

const encoder = new TextEncoder();

export function serializedSize(value: unknown): number {
  return encoder.encode(JSON.stringify(value) ?? "").length;
}

/**
 * Raised instead of sending an oversized context. The gateway can only tell a
 * client its total was too big; only the client knows which of six components
 * contributed the bulk of it, so that is what this names.
 */
export class ContextTooLargeError extends Error {
  readonly code = "context_too_large";
  readonly limit: number;
  readonly size: number;
  readonly largestSlice: string | null;

  constructor(limit: number, size: number, largestSlice: string | null) {
    super(
      `iri_context is ${size} bytes, over the ${limit} byte limit` +
        (largestSlice === null ? "" : `; the largest slice is "${largestSlice}"`),
    );
    this.name = "ContextTooLargeError";
    this.limit = limit;
    this.size = size;
    this.largestSlice = largestSlice;
  }
}

interface ResolvedSlice {
  key: string;
  value: ContextValue;
  options: ContextSliceOptions;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Calls every registered slice callback and awaits the results. A slice that
 * throws, rejects, times out, or produces something unserializable drops out
 * and is reported; the send proceeds on the rest, because a page that half
 * broke can still answer "what am I looking at".
 */
export async function resolveSlices(
  registry: SliceRegistry,
  options: { timeoutMs?: number; onFailure?: (failure: SliceFailure) => void } = {},
): Promise<ResolvedSlice[]> {
  const defaultTimeout = options.timeoutMs ?? DEFAULT_SLICE_TIMEOUT_MS;

  const settled = await Promise.all(
    registry.list().map(async (registration): Promise<ResolvedSlice | null> => {
      const timeoutMs = registration.options.timeoutMs ?? defaultTimeout;
      try {
        const value = await withTimeout(
          Promise.resolve().then(() => registration.callback()),
          timeoutMs,
        );
        // Serialize now so a cyclic or unserializable value fails as this one
        // slice rather than as the whole send.
        JSON.stringify(value);
        return { key: registration.key, value, options: registration.options };
      } catch (cause) {
        options.onFailure?.({
          key: registration.key,
          reason: cause instanceof Error && cause.message.startsWith("timed out") ? "timeout" : "threw",
          cause,
        });
        return null;
      }
    }),
  );

  return settled.filter((slice): slice is ResolvedSlice => slice !== null);
}

function truncatedValue(items: unknown[], total: number, kept: number) {
  // The marker matters: without it the model is told it has the whole payload.
  return { truncated: true, total, kept, items: items.slice(0, kept) };
}

/**
 * Merges resolved slices into the envelope, shrinking opted-in array slices if
 * that is what it takes to fit. Returns `undefined` when nothing is
 * registered, so the request omits `iri_context` entirely rather than sending
 * an empty object.
 */
export function buildContext(
  slices: ResolvedSlice[],
  options: { maxBytes?: number; onTruncate?: (notice: TruncationNotice) => void } = {},
): Record<string, unknown> | undefined {
  if (slices.length === 0) return undefined;

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_CONTEXT_BYTES;
  const values = new Map<string, unknown>(slices.map((slice) => [slice.key, slice.value]));
  const assemble = () => Object.fromEntries(values);

  if (serializedSize(assemble()) <= maxBytes) return assemble();

  // Over the limit. Shrink the truncatable array slices, largest first, until
  // it fits or there is nothing left to give.
  const truncatable = slices
    .filter((slice) => slice.options.truncate === true && Array.isArray(slice.value))
    .map((slice) => ({ key: slice.key, items: slice.value as unknown[] }))
    .sort((a, b) => serializedSize(b.items) - serializedSize(a.items));

  for (const slice of truncatable) {
    let kept = slice.items.length;
    while (kept > 0 && serializedSize(assemble()) > maxBytes) {
      kept = Math.floor(kept / 2);
      values.set(slice.key, truncatedValue(slice.items, slice.items.length, kept));
    }
    if (kept < slice.items.length) {
      options.onTruncate?.({ key: slice.key, total: slice.items.length, kept });
    }
    if (serializedSize(assemble()) <= maxBytes) return assemble();
  }

  const merged = assemble();
  const size = serializedSize(merged);
  if (size <= maxBytes) return merged;

  let largest: string | null = null;
  let largestSize = -1;
  for (const [key, value] of values) {
    const bytes = serializedSize(value);
    if (bytes > largestSize) {
      largestSize = bytes;
      largest = key;
    }
  }
  throw new ContextTooLargeError(maxBytes, size, largest);
}
