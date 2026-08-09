import { isOriginAllowed } from "../../config.ts";
import type { McpRuntime } from "./discovery.ts";

/**
 * Re-list every cached MCP server whose entry has gone stale.
 *
 * Runs on the same tick that refreshes app manifests — the problem is the same
 * shape, and so is the failure handling: log at `warn` and leave the previous
 * entry in place rather than emptying it, so a server that is briefly down does
 * not take its tools away from runs in flight.
 *
 * Only servers already discovered are refreshed. A declared-but-never-used
 * server has no cache entry and is left for its first run to discover.
 */
export async function refreshStaleMcpTools(rt: McpRuntime): Promise<void> {
  for (const entry of rt.cache.stale(rt.cacheTtlMs)) {
    const target = { url: entry.url, headers: entry.headers };
    if (!isOriginAllowed(entry.url, rt.allowedOrigins)) {
      // The allowlist tightened since this entry was cached.
      rt.cache.invalidate(target);
      rt.logger.warn("mcp.refresh_failed", {
        url: entry.url,
        reason: "origin_not_allowed",
      });
      continue;
    }
    try {
      const client = await rt.pool.acquire(target);
      const listed = await client.listTools();
      const tools = (listed.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description || t.name,
        inputSchema: (t.inputSchema ?? { type: "object", properties: {} }) as Record<
          string,
          unknown
        >,
      }));
      rt.cache.set(target, tools);
      rt.logger.info("mcp.refreshed", { url: entry.url, tool_count: tools.length });
    } catch (err) {
      await rt.pool.discard(target);
      rt.logger.warn("mcp.refresh_failed", {
        url: entry.url,
        err: (err as Error).message,
      });
    }
  }
}
