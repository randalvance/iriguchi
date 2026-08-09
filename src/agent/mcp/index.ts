import type { Config } from "../../config.ts";
import type { Logger } from "../../logger.ts";
import { createClientPool } from "./client.ts";
import { createToolCache } from "./cache.ts";
import type { McpRuntime } from "./discovery.ts";

export { createClientPool, connectionKey } from "./client.ts";
export { createToolCache } from "./cache.ts";
export type { DiscoveredTool, CacheEntry, ToolCache } from "./cache.ts";
export { discoverTools, expandAgentTools } from "./discovery.ts";
export type { McpRuntime, ResolvedMcpTool } from "./discovery.ts";
export { invokeMcpTool } from "./invoke.ts";
export {
  prefixToolName,
  splitExposedName,
  rejectExposedName,
  MAX_TOOL_NAME_LENGTH,
} from "./naming.ts";
export { refreshStaleMcpTools } from "./refresh.ts";

/**
 * The gateway's shared MCP state: one connection pool and one tool cache for
 * the process, so agents declaring the same server reuse both.
 */
export function createMcpRuntime(opts: {
  config: Pick<Config, "mcpCacheTtlMs" | "mcpAllowedOrigins">;
  logger: Logger;
}): McpRuntime {
  return {
    pool: createClientPool(),
    cache: createToolCache(),
    cacheTtlMs: opts.config.mcpCacheTtlMs,
    allowedOrigins: opts.config.mcpAllowedOrigins,
    logger: opts.logger,
  };
}
