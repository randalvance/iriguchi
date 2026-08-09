import { Hono } from "hono";
import { listen, type TestServer } from "./listen.ts";

/**
 * A stateless streamable-HTTP MCP server, shaped after the deployed finance-mcp
 * this feature was built against: `POST /mcp` only, `405` on `GET` and
 * `DELETE`, no session id, and a hard requirement that the client accept both
 * `application/json` and `text/event-stream`. That last one is the single most
 * likely thing for a client to get wrong, so the fake enforces it rather than
 * letting a broken client pass.
 */

export type FakeTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

/** What a `tools/call` should do. Default: echo the arguments back as JSON. */
export type ToolBehavior =
  | { kind: "json"; data: unknown }
  | { kind: "text"; text: string }
  | { kind: "tool_error"; text: string }
  | { kind: "jsonrpc_error"; code: number; message: string }
  | { kind: "http_error"; status: number; body?: string }
  | { kind: "hang" };

export type FakeMcpOpts = {
  tools?: FakeTool[];
  /** Per-tool behavior, by tool name. */
  behaviors?: Record<string, ToolBehavior>;
  /** Applied to `tools/list` rather than a tool call. */
  listBehavior?: Extract<ToolBehavior, { kind: "jsonrpc_error" | "http_error" | "hang" }>;
};

export type FakeMcpServer = TestServer & {
  url: string;
  /** Every JSON-RPC method received, in order — `["initialize", "tools/list"]`. */
  methods: string[];
  calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  countOf(method: string): number;
  /** Swap the advertised tools mid-test, to exercise re-discovery. */
  setTools(tools: FakeTool[]): void;
  setBehavior(toolName: string, behavior: ToolBehavior): void;
};

const DEFAULT_TOOLS: FakeTool[] = [
  {
    name: "list_accounts",
    description: "List every financial account, with its currency.",
    inputSchema: { type: "object", properties: {} },
  },
];

const PROTOCOL_VERSION = "2025-06-18";

export function spinUpFakeMcpServer(opts: FakeMcpOpts = {}): FakeMcpServer {
  let tools = opts.tools ?? DEFAULT_TOOLS;
  const behaviors: Record<string, ToolBehavior> = { ...(opts.behaviors ?? {}) };
  const methods: string[] = [];
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];

  const app = new Hono();

  app.on(["GET", "DELETE"], "/mcp", (c) => c.text("Method Not Allowed", 405));

  app.post("/mcp", async (c) => {
    const accept = c.req.header("accept") ?? "";
    if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
      return c.json(
        {
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Not Acceptable: Client must accept both application/json and text/event-stream",
          },
          id: null,
        },
        406,
      );
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      id?: unknown;
      method?: string;
      params?: Record<string, unknown>;
    };
    const { id, method } = body;
    if (typeof method === "string") methods.push(method);

    const reply = (result: unknown) => c.json({ jsonrpc: "2.0", id, result });
    const fail = (code: number, message: string) =>
      c.json({ jsonrpc: "2.0", id, error: { code, message } });

    if (method === "initialize") {
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "fake-mcp", version: "0.1.0" },
      });
    }

    // Notifications carry no id and expect no body.
    if (method?.startsWith("notifications/")) return c.body(null, 202);

    if (method === "tools/list") {
      const behavior = opts.listBehavior;
      if (behavior?.kind === "hang") return hang();
      if (behavior?.kind === "http_error") {
        return c.text(behavior.body ?? "upstream failure", behavior.status as 500);
      }
      if (behavior?.kind === "jsonrpc_error") return fail(behavior.code, behavior.message);
      return reply({
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description ?? t.name,
          inputSchema: t.inputSchema ?? { type: "object", properties: {} },
        })),
      });
    }

    if (method === "tools/call") {
      const name = String(body.params?.name ?? "");
      const args = (body.params?.arguments ?? {}) as Record<string, unknown>;
      calls.push({ name, arguments: args });

      if (!tools.some((t) => t.name === name)) {
        return reply({
          isError: true,
          content: [{ type: "text", text: `MCP error -32602: Tool ${name} not found` }],
        });
      }

      const behavior = behaviors[name] ?? { kind: "json", data: { echoed: args } };
      switch (behavior.kind) {
        case "hang":
          return hang();
        case "http_error":
          return c.text(behavior.body ?? "upstream failure", behavior.status as 500);
        case "jsonrpc_error":
          return fail(behavior.code, behavior.message);
        case "tool_error":
          return reply({ isError: true, content: [{ type: "text", text: behavior.text }] });
        case "text":
          return reply({ content: [{ type: "text", text: behavior.text }] });
        case "json":
          return reply({
            content: [{ type: "text", text: JSON.stringify(behavior.data) }],
          });
      }
    }

    return fail(-32601, `Method not found: ${method}`);
  });

  const server = listen({ port: 0, fetch: app.fetch, idleTimeout: 255 });

  return {
    ...server,
    url: `http://127.0.0.1:${server.port}/mcp`,
    methods,
    calls,
    countOf: (method) => methods.filter((m) => m === method).length,
    setTools(next) {
      tools = next;
    },
    setBehavior(toolName, behavior) {
      behaviors[toolName] = behavior;
    },
  };
}

/** Never resolves, so the caller's own timeout is what ends the request. */
function hang(): Promise<Response> {
  return new Promise<Response>(() => {});
}

/** A URL on a closed port, for exercising connection-refused paths. */
export async function unreachableMcpUrl(): Promise<string> {
  const throwaway = listen({ port: 0, fetch: () => new Response("ok") });
  const url = `http://127.0.0.1:${throwaway.port}/mcp`;
  await throwaway.stop();
  return url;
}
