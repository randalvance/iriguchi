import type { ContextCallback, ContextSliceOptions, Registration } from "./types.js";

/** True unless something has explicitly said this is a production build. */
export function isDevelopment(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.["NODE_ENV"] !== "production";
}

/**
 * Holds the registered context slices. Keyed by slice name, so a duplicate
 * registration replaces rather than accumulates: last-wins is the only
 * behaviour that stays predictable when two components mount in an order the
 * app does not control.
 */
export class SliceRegistry {
  #slices = new Map<string, Registration>();

  register(
    key: string,
    callback: ContextCallback,
    options: ContextSliceOptions = {},
  ): () => void {
    if (this.#slices.has(key) && isDevelopment()) {
      console.warn(
        `[iriguchi] context slice "${key}" is registered by more than one ` +
          `mounted component; the most recent registration wins.`,
      );
    }
    const registration: Registration = { kind: "context", key, callback, options };
    this.#slices.set(key, registration);
    return () => {
      // Only remove our own registration. A component unmounting after another
      // has taken the key over must not delete the newer one.
      if (this.#slices.get(key) === registration) this.#slices.delete(key);
    };
  }

  list(): Registration[] {
    return [...this.#slices.values()];
  }

  get size(): number {
    return this.#slices.size;
  }
}
