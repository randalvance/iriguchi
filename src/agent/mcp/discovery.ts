import type { McpServerTool, Tool } from "../../registry/schema.ts";
import type { Logger } from "../../logger.ts";
import { isOriginAllowed } from "../../config.ts";
import type { ClientPool } from "./client.ts";
import type { DiscoveredTool, ToolCache } from "./cache.ts";
import { prefixToolName, rejectExposedName } from "./naming.ts";

export type McpRuntime = {
  pool: ClientPool;
  cache: ToolCache;
  cacheTtlMs: number;
  allowedOrigins: string[];
  logger: Logger;
};

/** A discovered tool bound to the manifest entry it came from. */
export type ResolvedMcpTool = {
  /** Name the model sees: `<server>__<tool>`. */
  exposedName: string;
  /** Name the server knows it by. */
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  entry: McpServerTool;
};

function normalizeTools(raw: unknown): DiscoveredTool[] {
  const tools = (raw as { tools?: unknown[] })?.tools;
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((t) => {
    const tool = t as Record<string, unknown>;
    const name = typeof tool.name === "string" ? tool.name : null;
    if (!name) return [];
    return [
      {
        name,
        // A server may omit description; the model still needs something.
        description:
          typeof tool.description === "string" && tool.description
            ? tool.description
            : name,
        inputSchema:
          tool.inputSchema && typeof tool.inputSchema === "object"
            ? (tool.inputSchema as Record<string, unknown>)
            : { type: "object", properties: {} },
      },
    ];
  });
}

/**
 * The tools a declared server advertises, from cache when fresh.
 *
 * Never throws. Discovery failure costs the server its tools, not the run: the
 * caller gets an empty list and a `warn` is logged naming the server and the
 * reason.
 */
export async function discoverTools(
  entry: McpServerTool,
  rt: McpRuntime,
): Promise<DiscoveredTool[]> {
  if (!isOriginAllowed(entry.url, rt.allowedOrigins)) {
    // Re-checked here and not only at registration, so tightening the allowlist
    // takes effect against manifests already in the store.
    rt.logger.warn("mcp.discovery_refused", {
      server: entry.name,
      url: entry.url,
      reason: "origin_not_allowed",
    });
    return [];
  }

  const fresh = rt.cache.getFresh(entry, rt.cacheTtlMs);
  if (fresh) return applyAllowlist(entry, fresh.tools);

  try {
    const client = await rt.pool.acquire(entry);
    const listed = await client.listTools();
    const tools = normalizeTools(listed);
    rt.cache.set(entry, tools);
    rt.logger.info("mcp.discovered", {
      server: entry.name,
      url: entry.url,
      tool_count: tools.length,
    });
    return applyAllowlist(entry, tools);
  } catch (err) {
    await rt.pool.discard(entry);
    rt.logger.warn("mcp.discovery_failed", {
      server: entry.name,
      url: entry.url,
      err: (err as Error).message,
    });
    // A previously discovered list outlives a failed re-list: better a stale
    // tool surface than none.
    const stale = rt.cache.peek(entry);
    return stale ? applyAllowlist(entry, stale.tools) : [];
  }
}

function applyAllowlist(entry: McpServerTool, tools: DiscoveredTool[]): DiscoveredTool[] {
  if (!entry.tools) return tools;
  const allowed = new Set(entry.tools);
  return tools.filter((t) => allowed.has(t.name));
}

/**
 * Expand an agent's declared tools into what the model actually sees.
 *
 * `api_call` entries are already one tool each and pass through untouched. Each
 * `mcp` entry is a reference that fans out into however many tools its server
 * advertises, prefixed and collision-checked against everything already
 * claimed on this agent.
 */
export async function expandAgentTools(
  tools: Tool[],
  rt: McpRuntime,
): Promise<{
  apiCallTools: Extract<Tool, { type: "api_call" }>[];
  mcpTools: ResolvedMcpTool[];
}> {
  const apiCallTools = tools.filter((t) => t.type === "api_call");
  const taken = new Set(apiCallTools.map((t) => t.name));
  const mcpEntries = tools.filter((t) => t.type === "mcp");
  const resolved: ResolvedMcpTool[] = [];

  for (const entry of mcpEntries) {
    const discovered = await discoverTools(entry, rt);
    for (const tool of discovered) {
      const exposedName = prefixToolName(entry.name, tool.name);
      const rejection = rejectExposedName(exposedName, taken);
      if (rejection) {
        rt.logger.warn("mcp.tool_dropped", {
          server: entry.name,
          tool: tool.name,
          exposed_name: exposedName,
          reason: rejection,
        });
        continue;
      }
      taken.add(exposedName);
      resolved.push({
        exposedName,
        toolName: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        entry,
      });
    }
  }

  return { apiCallTools, mcpTools: resolved };
}
