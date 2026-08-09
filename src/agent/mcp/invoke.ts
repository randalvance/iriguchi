import { setTimeout as sleep } from "node:timers/promises";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerTool } from "../../registry/schema.ts";
import type { McpRuntime } from "./discovery.ts";

/**
 * MCP failures reach the model in the same shapes `invokeApiCallTool` already
 * produces. Three distinct things can go wrong and they are not
 * interchangeable:
 *
 *  - transport   — never reached the server, or it answered non-2xx
 *  - JSON-RPC    — reached it, and it refused at the protocol layer
 *  - `isError`   — the tool itself ran and failed
 *
 * The first maps onto the existing `network` / `timeout` / `{status, body}`
 * forms verbatim, so a model reading a tool result cannot tell whether an app
 * endpoint or an MCP server failed. The other two get their own `kind`, added
 * to the contract rather than replacing anything.
 */

type CallOutcome =
  | { ok: true; data: unknown }
  | {
      ok: false;
      retriable: boolean;
      error: Record<string, unknown>;
    };

/** MCP content blocks flattened to a single string. */
function flattenContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const b = block as Record<string, unknown>;
      if (b?.type === "text" && typeof b.text === "string") return b.text;
      return JSON.stringify(b);
    })
    .join("\n");
}

/** Text that parses as JSON is handed to the model parsed, not as a string. */
function parseIfJson(text: string): unknown {
  if (!text) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Classify a thrown error.
 *
 * `McpError` and `StreamableHTTPError` both expose a numeric `code`, and they
 * mean entirely different things — a JSON-RPC error code on one, an HTTP status
 * on the other. Only the class distinguishes them, so this checks `instanceof`
 * rather than sniffing fields.
 */
function classifyThrown(err: unknown, timeoutMs: number): CallOutcome {
  const e = err as { name?: string; code?: unknown; message?: string };

  const timedOut =
    e?.name === "AbortError" ||
    e?.name === "TimeoutError" ||
    (err instanceof McpError && err.code === ErrorCode.RequestTimeout);
  if (timedOut) {
    return {
      ok: false,
      retriable: true,
      error: { kind: "timeout", message: `request exceeded ${timeoutMs}ms` },
    };
  }

  // An HTTP failure is a transport failure and gets the transport shape, so a
  // model cannot tell it apart from an app endpoint returning the same status.
  if (err instanceof StreamableHTTPError) {
    const status = typeof err.code === "number" ? err.code : null;
    if (status === null) {
      return {
        ok: false,
        retriable: true,
        error: { kind: "network", message: err.message },
      };
    }
    return {
      ok: false,
      retriable: status >= 500,
      error: { status, body: err.message },
    };
  }

  if (err instanceof McpError) {
    return {
      ok: false,
      // A protocol-level refusal is deterministic; retrying re-asks the same
      // question and gets the same answer.
      retriable: false,
      error: { kind: "mcp_protocol", code: err.code, message: err.message },
    };
  }

  return {
    ok: false,
    retriable: true,
    error: { kind: "network", message: e?.message ?? String(err) },
  };
}

async function callOnce(opts: {
  entry: McpServerTool;
  toolName: string;
  input: Record<string, unknown>;
  timeoutMs: number;
  rt: McpRuntime;
}): Promise<CallOutcome> {
  try {
    const client = await opts.rt.pool.acquire(opts.entry);
    const result = (await client.callTool(
      { name: opts.toolName, arguments: opts.input },
      undefined,
      { timeout: opts.timeoutMs },
    )) as { isError?: boolean; content?: unknown; structuredContent?: unknown };

    if (result.isError) {
      return {
        ok: false,
        // The gateway cannot know a tool is idempotent — MCP does not declare
        // it — so a tool that ran and failed is reported, not re-run. The model
        // sees the server's own text and may elect to call again. This is what
        // makes finance-mcp's cold-Neon-pool "Failed query" recoverable.
        retriable: false,
        error: {
          kind: "mcp_tool_error",
          message: flattenContent(result.content),
        },
      };
    }

    // `structuredContent` is already typed data; prefer it over reparsing text.
    if (result.structuredContent !== undefined) {
      return { ok: true, data: result.structuredContent };
    }
    return { ok: true, data: parseIfJson(flattenContent(result.content)) };
  } catch (err) {
    const outcome = classifyThrown(err, opts.timeoutMs);
    // The pooled connection is suspect after anything but a clean protocol
    // refusal; drop it so the retry reconnects.
    if (outcome.ok === false && outcome.retriable) {
      await opts.rt.pool.discard(opts.entry);
    }
    return outcome;
  }
}

export async function invokeMcpTool(opts: {
  entry: McpServerTool;
  /** The tool's own name, prefix already stripped. */
  toolName: string;
  input: Record<string, unknown>;
  defaultTimeoutMs: number;
  rt: McpRuntime;
}): Promise<unknown> {
  const timeoutMs = opts.entry.timeout_ms ?? opts.defaultTimeoutMs;
  const args = {
    entry: opts.entry,
    toolName: opts.toolName,
    input: opts.input,
    timeoutMs,
    rt: opts.rt,
  };

  let attempt = await callOnce(args);
  // Mirrors invokeApiCallTool: one retry, transport failures only.
  if (!attempt.ok && attempt.retriable) {
    await sleep(500);
    attempt = await callOnce(args);
  }

  if (attempt.ok) return attempt.data;
  return { error: attempt.error };
}
