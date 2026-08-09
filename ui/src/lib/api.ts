/**
 * The `/internal/*` client.
 *
 * Every network call the UI makes goes through here, and every one of them can
 * fail the same three ways: the gateway is not reachable, it answered with an
 * error, or it answered with something unparseable. `ApiError` collapses those
 * into one thing the panels can render, which is what lets a failure become a
 * visible state instead of a blank container.
 *
 * There is no credential handling anywhere in this file, and that is not an
 * omission. `/internal/*` takes none, and chat is proxied server-side precisely
 * so the browser never holds the gateway's API key.
 */

export type AgentSummary = {
  id: string;
  name: string;
  description: string;
  app_id: string;
  app_name: string;
  app_base_url: string;
  provider: string;
  model: string;
  api_call_tool_count: number;
  mcp_server_count: number;
  skill_count: number;
};

export type ApiCallToolView = {
  name: string;
  description: string;
  method: string;
  path: string;
  timeout_ms: number | null;
  parameters: Record<string, unknown>;
};

export type McpServerView = {
  name: string;
  url: string;
  header_names: string[];
  allowed_tools: string[] | null;
  timeout_ms: number | null;
};

export type SkillView = { name: string; source: "inline" | "url" };

export type AgentDetail = AgentSummary & {
  system_prompt: string;
  api_call_tools: ApiCallToolView[];
  mcp_servers: McpServerView[];
  skills: SkillView[];
};

export type McpStatus = "ok" | "stale" | "unknown" | "unreachable";

export type McpServerStatus = {
  names: string[];
  url: string;
  header_names: string[];
  agents: string[];
  status: McpStatus;
  tool_count: number | null;
  discovered_at: number | null;
  error: string | null;
  error_at: number | null;
};

export type ProbeResult = {
  server: string;
  url: string;
  status: "ok" | "unreachable";
  tool_count: number | null;
  tools: string[];
  discovered_at: number | null;
  error: string | null;
  probed_at: number;
};

export type ChatMessage = { role: "user" | "assistant"; content: string };

export class ApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * Absolute, because the page is served from `/ui/` and a relative path would
 * resolve under it. Same origin either way — the UI and the gateway are one
 * process on one port.
 */
const BASE = "/internal";

async function getJson<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { headers: { Accept: "application/json" } });
  } catch (err) {
    throw new ApiError(
      `cannot reach the gateway (${(err as Error).message}). Is it still running?`,
    );
  }
  return parse<T>(res, path);
}

async function postJson<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    throw new ApiError(
      `cannot reach the gateway (${(err as Error).message}). Is it still running?`,
    );
  }
  return parse<T>(res, path);
}

async function parse<T>(res: Response, path: string): Promise<T> {
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // A non-JSON body from a JSON endpoint is itself the diagnosis — most
    // often the "UI not built" plain-text response or a proxy's error page.
    throw new ApiError(
      `${path} returned ${res.status} with a non-JSON body: ${text.slice(0, 120)}`,
      res.status,
    );
  }
  if (!res.ok) {
    throw new ApiError(body?.error?.message ?? `${path} failed with ${res.status}`, res.status);
  }
  return body as T;
}

export const api = {
  listAgents: () => getJson<{ agents: AgentSummary[] }>("/agents").then((r) => r.agents),

  getAgent: (id: string) => getJson<AgentDetail>(`/agents/${encodeURIComponent(id)}`),

  listMcpServers: () =>
    getJson<{ servers: McpServerStatus[]; cache_ttl_ms: number }>("/mcp/servers"),

  probeMcpServer: (agentId: string, serverName: string) =>
    postJson<ProbeResult>(
      `/agents/${encodeURIComponent(agentId)}/mcp/${encodeURIComponent(serverName)}/probe`,
    ),

  /**
   * Open a chat run. Returns the raw response so the caller can read the SSE
   * body incrementally — the whole point is rendering tokens as they arrive,
   * which `.json()` would defeat.
   */
  async openChat(agentId: string, messages: ChatMessage[], signal?: AbortSignal) {
    let res: Response;
    try {
      res = await fetch(`${BASE}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: agentId, messages }),
        signal,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      throw new ApiError(`cannot reach the gateway (${(err as Error).message}).`);
    }
    if (!res.ok) {
      const text = await res.text();
      let message = `chat failed with ${res.status}`;
      try {
        message = JSON.parse(text)?.error?.message ?? message;
      } catch {
        /* keep the status-based message */
      }
      throw new ApiError(message, res.status);
    }
    if (!res.body) throw new ApiError("the gateway returned an empty response body");
    return res.body;
  },
};

/**
 * Read an OpenAI SSE stream, yielding assistant text as it arrives.
 *
 * Throws on an error event so a mid-stream failure surfaces as a failure. The
 * gateway emits `data: {"error": ...}` followed by `[DONE]` when a run breaks
 * after headers are committed; treating that as ordinary content would render
 * the error as if the assistant had said it.
 */
export async function* readChatStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE events are separated by a blank line; a chunk boundary can fall
    // anywhere, so only complete events are consumed.
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";

    for (const event of events) {
      const line = event.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;

      let parsed: any;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      if (parsed.error) {
        throw new ApiError(
          typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error),
        );
      }
      const delta = parsed.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta) yield delta;
    }
  }
}

/** "2m ago" / "just now" — a status with no time on it implies a liveness the gateway does not have. */
export function relativeTime(ts: number | null): string {
  if (ts === null) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
