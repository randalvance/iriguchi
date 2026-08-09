import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerTool } from "../../registry/schema.ts";

/**
 * The MCP client layer. Nothing in this directory imports
 * `@anthropic-ai/claude-agent-sdk`: the gateway's agent runtime is expected to
 * change out from under it, and MCP is a property of the tool, not of the
 * runtime that happens to be exposing it.
 */

const CLIENT_NAME = "iriguchi";
const CLIENT_VERSION = "1.0.0";

/**
 * Identity of a connection. Two agents declaring the same URL with the same
 * headers share one client and one cache entry; differing headers are a
 * different connection, since they may authenticate as a different principal.
 */
export function connectionKey(entry: Pick<McpServerTool, "url" | "headers">): string {
  const headers = entry.headers ?? {};
  const stable = Object.keys(headers)
    .sort()
    .map((k) => [k, headers[k]]);
  return JSON.stringify([entry.url, stable]);
}

export type PooledClient = {
  client: Client;
  close(): Promise<void>;
};

export type ClientPool = {
  /** Returns a connected client, creating and connecting one if absent. */
  acquire(entry: Pick<McpServerTool, "url" | "headers">): Promise<Client>;
  /**
   * Drop a client after a transport failure so the next acquire reconnects.
   * Closing is best-effort: the connection is already known to be broken.
   */
  discard(entry: Pick<McpServerTool, "url" | "headers">): Promise<void>;
  closeAll(): Promise<void>;
};

export function createClientPool(): ClientPool {
  // Stores the in-flight promise rather than the resolved client so that two
  // concurrent runs needing the same server share one connect rather than
  // racing to build two.
  const clients = new Map<string, Promise<Client>>();

  const connect = async (entry: Pick<McpServerTool, "url" | "headers">): Promise<Client> => {
    const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });
    const transport = new StreamableHTTPClientTransport(new URL(entry.url), {
      requestInit: { headers: entry.headers ?? {} },
    });
    await client.connect(transport);
    return client;
  };

  return {
    async acquire(entry) {
      const key = connectionKey(entry);
      let pending = clients.get(key);
      if (!pending) {
        pending = connect(entry);
        clients.set(key, pending);
        // A failed connect must not be cached as a permanently poisoned entry.
        pending.catch(() => clients.delete(key));
      }
      return pending;
    },

    async discard(entry) {
      const key = connectionKey(entry);
      const pending = clients.get(key);
      clients.delete(key);
      if (!pending) return;
      try {
        const client = await pending;
        await client.close();
      } catch {
        // Already broken; nothing to salvage.
      }
    },

    async closeAll() {
      const pending = [...clients.values()];
      clients.clear();
      await Promise.all(
        pending.map(async (p) => {
          try {
            await (await p).close();
          } catch {
            // Best effort.
          }
        }),
      );
    },
  };
}
