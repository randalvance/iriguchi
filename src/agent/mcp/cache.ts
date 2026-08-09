import type { McpServerTool } from "../../registry/schema.ts";
import { connectionKey } from "./client.ts";

/** A tool as advertised by a server's `tools/list`. */
export type DiscoveredTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type CacheEntry = {
  url: string;
  headers: Record<string, string>;
  tools: DiscoveredTool[];
  fetched_at: number;
};

/**
 * In-memory tool-list cache.
 *
 * Deliberately not persisted, unlike app manifests. A manifest is needed to
 * answer `/v1/models` and route agents before any app re-registers; a
 * discovered tool list is only needed mid-run and costs one round-trip to
 * rebuild, so persisting it would buy a cold-start optimization at the price of
 * a store migration.
 */
export type ToolCache = {
  /** The entry for this connection, fresh or stale. */
  peek(entry: Pick<McpServerTool, "url" | "headers">): CacheEntry | null;
  /** The entry only if younger than `ttlMs`. */
  getFresh(
    entry: Pick<McpServerTool, "url" | "headers">,
    ttlMs: number,
    now?: number,
  ): CacheEntry | null;
  set(
    entry: Pick<McpServerTool, "url" | "headers">,
    tools: DiscoveredTool[],
    now?: number,
  ): CacheEntry;
  invalidate(entry: Pick<McpServerTool, "url" | "headers">): void;
  /** Every entry older than `ttlMs`, for the background refresher to re-list. */
  stale(ttlMs: number, now?: number): CacheEntry[];
  entries(): CacheEntry[];
  clear(): void;
};

export function createToolCache(): ToolCache {
  const byKey = new Map<string, CacheEntry>();

  return {
    peek(entry) {
      return byKey.get(connectionKey(entry)) ?? null;
    },

    getFresh(entry, ttlMs, now = Date.now()) {
      const hit = byKey.get(connectionKey(entry));
      if (!hit) return null;
      return now - hit.fetched_at < ttlMs ? hit : null;
    },

    set(entry, tools, now = Date.now()) {
      const stored: CacheEntry = {
        url: entry.url,
        headers: entry.headers ?? {},
        tools,
        fetched_at: now,
      };
      byKey.set(connectionKey(entry), stored);
      return stored;
    },

    invalidate(entry) {
      byKey.delete(connectionKey(entry));
    },

    stale(ttlMs, now = Date.now()) {
      return [...byKey.values()].filter((e) => now - e.fetched_at >= ttlMs);
    },

    entries() {
      return [...byKey.values()];
    },

    clear() {
      byKey.clear();
    },
  };
}
