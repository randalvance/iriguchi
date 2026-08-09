import type { McpServerTool } from "../registry/schema.ts";
import type { Store } from "../registry/store.ts";
import type { Config } from "../config.ts";
import { connectionKey } from "../agent/mcp/client.ts";
import { discoverTools, type McpRuntime } from "../agent/mcp/discovery.ts";
import { isOriginAllowed } from "../config.ts";
import { agentMcpServers, findAgent } from "./catalog.ts";

/**
 * Observability over the MCP tool cache.
 *
 * The cache records successes only — a failed `tools/list` leaves no trace —
 * and discovery is lazy, so a server nobody has needed yet is indistinguishable
 * from one that is down. Both are invisible failures to an operator staring at
 * a catalog. This module adds the missing half: a record of the last *failed*
 * attempt, kept alongside the cache rather than inside it.
 *
 * Failures live here and not on `CacheEntry` deliberately. `CacheEntry` models
 * a successful listing and is consumed by discovery, invocation, and the
 * background refresher; giving it a failure shape would force every one of
 * those to handle an entry that holds no tools, to serve a read-only view.
 */

export type McpStatus = "ok" | "stale" | "unknown" | "unreachable";

export type McpServerStatus = {
  /** Manifest-declared name. Shared connections may be declared under different names. */
  names: string[];
  url: string;
  header_names: string[];
  /** Agent ids declaring this exact connection. */
  agents: string[];
  status: McpStatus;
  /** Tools in the last successful listing, or null if there has never been one. */
  tool_count: number | null;
  /** When that listing happened. */
  discovered_at: number | null;
  /** Message from the most recent failed attempt, if the failure is the current state. */
  error: string | null;
  error_at: number | null;
};

export type ProbeResult = {
  server: string;
  url: string;
  status: Extract<McpStatus, "ok" | "unreachable">;
  tool_count: number | null;
  tools: string[];
  discovered_at: number | null;
  error: string | null;
  probed_at: number;
};

type Failure = { message: string; at: number };

export type McpStatusTracker = {
  recordFailure(entry: Pick<McpServerTool, "url" | "headers">, message: string, now?: number): void;
  clearFailure(entry: Pick<McpServerTool, "url" | "headers">): void;
  lastFailure(entry: Pick<McpServerTool, "url" | "headers">): Failure | null;
};

export function createMcpStatusTracker(): McpStatusTracker {
  const failures = new Map<string, Failure>();
  return {
    recordFailure(entry, message, now = Date.now()) {
      failures.set(connectionKey(entry), { message, at: now });
    },
    clearFailure(entry) {
      failures.delete(connectionKey(entry));
    },
    lastFailure(entry) {
      return failures.get(connectionKey(entry)) ?? null;
    },
  };
}

/**
 * Every distinct MCP connection declared across the registry, with its state.
 *
 * Performs no network I/O: the catalog must render at full speed when every
 * declared server is down, and a page load is not consent to dial out.
 */
export function collectMcpStatuses(opts: {
  store: Store;
  mcp: McpRuntime;
  tracker: McpStatusTracker;
  now?: number;
}): McpServerStatus[] {
  const { store, mcp, tracker } = opts;
  const now = opts.now ?? Date.now();
  // Keyed by connection, not by name: two agents naming the same URL and
  // headers share one client and one cache entry, so they are one thing to
  // probe and one thing to report.
  const byConnection = new Map<string, McpServerStatus>();

  for (const app of store.listApps()) {
    for (const agent of app.manifest?.agents ?? []) {
      for (const entry of agentMcpServers(agent)) {
        const key = connectionKey(entry);
        let row = byConnection.get(key);
        if (!row) {
          const cached = mcp.cache.peek(entry);
          const failure = tracker.lastFailure(entry);
          row = {
            names: [],
            url: entry.url,
            header_names: Object.keys(entry.headers ?? {}).sort(),
            agents: [],
            status: deriveStatus(cached?.fetched_at ?? null, failure, mcp.cacheTtlMs, now),
            tool_count: cached?.tools.length ?? null,
            discovered_at: cached?.fetched_at ?? null,
            error: failure?.message ?? null,
            error_at: failure?.at ?? null,
          };
          byConnection.set(key, row);
        }
        if (!row.names.includes(entry.name)) row.names.push(entry.name);
        if (!row.agents.includes(agent.id)) row.agents.push(agent.id);
      }
    }
  }

  return [...byConnection.values()];
}

function deriveStatus(
  fetchedAt: number | null,
  failure: Failure | null,
  ttlMs: number,
  now: number,
): McpStatus {
  // A failure newer than the last success is the current state. Ordering the
  // two by time rather than preferring either means a server that recovered
  // stops reading as broken without anyone clearing the record.
  if (failure && (fetchedAt === null || failure.at >= fetchedAt)) return "unreachable";
  if (fetchedAt === null) return "unknown";
  return now - fetchedAt < ttlMs ? "ok" : "stale";
}

export class ProbeTargetError extends Error {}

/**
 * Resolve `(agentId, serverName)` to a declared server.
 *
 * The probe endpoint takes these two identifiers and never a URL or a header
 * set. An unauthenticated endpoint that fetched a caller-supplied URL would be
 * an SSRF primitive aimed at the gateway's own network; going through the
 * registry means a probe can only reach somewhere a registered manifest already
 * names — and that the origin allowlist has already vetted.
 */
export function resolveProbeTarget(
  store: Store,
  agentId: string,
  serverName: string,
): McpServerTool {
  const found = findAgent(store, agentId);
  if (!found) throw new ProbeTargetError(`unknown agent: ${agentId}`);
  const entry = agentMcpServers(found.agent).find((s) => s.name === serverName);
  if (!entry) {
    throw new ProbeTargetError(`agent "${agentId}" declares no mcp server named "${serverName}"`);
  }
  return entry;
}

/**
 * Force a `tools/list` against a declared server and report what happened.
 *
 * A failure is an outcome, not an exception: the caller asked "is it up", and
 * "no, because ECONNREFUSED" is a complete answer. Success populates the same
 * cache a run would, so a probe warms the catalog rather than living beside it.
 */
export async function probeMcpServer(opts: {
  entry: McpServerTool;
  mcp: McpRuntime;
  tracker: McpStatusTracker;
  config: Pick<Config, "mcpAllowedOrigins">;
}): Promise<ProbeResult> {
  const { entry, mcp, tracker } = opts;
  const probedAt = Date.now();

  const failed = (message: string): ProbeResult => {
    tracker.recordFailure(entry, message, probedAt);
    return {
      server: entry.name,
      url: entry.url,
      status: "unreachable",
      tool_count: null,
      tools: [],
      discovered_at: null,
      error: message,
      probed_at: probedAt,
    };
  };

  if (!isOriginAllowed(entry.url, opts.config.mcpAllowedOrigins)) {
    return failed(`origin not permitted by IRI_MCP_ALLOWED_ORIGINS: ${entry.url}`);
  }

  // Drop any cached list first: `discoverTools` serves a fresh cache hit
  // without dialing out, which would make the probe button a no-op precisely
  // when someone is pressing it to check whether a server came back.
  mcp.cache.invalidate(entry);

  // `discoverTools` never throws — a failing server costs its own tools and
  // nothing else — so the reason arrives through the failure hook rather than
  // as an exception.
  let reason: string | null = null;
  await discoverTools(entry, {
    ...mcp,
    onDiscoveryFailure: (_e, r) => {
      reason = r;
    },
  });

  if (reason !== null) return failed(reason);

  const listed = mcp.cache.peek(entry);
  if (!listed) return failed("tools/list returned no result");

  tracker.clearFailure(entry);
  return {
    server: entry.name,
    url: entry.url,
    status: "ok",
    tool_count: listed.tools.length,
    tools: listed.tools.map((t) => t.name),
    discovered_at: listed.fetched_at,
    error: null,
    probed_at: probedAt,
  };
}
