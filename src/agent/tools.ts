import type { Tool } from "../registry/schema.ts";

export type ToolInvocationResult = unknown; // either app's JSON or { error: { ... } }

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}

async function callOnce(opts: {
  url: string;
  method: string;
  body: unknown;
  appToken: string;
  timeoutMs: number;
}): Promise<{ ok: true; data: unknown } | { ok: false; kind: "http" | "timeout" | "network"; status?: number; body?: unknown; message?: string }> {
  try {
    const init: RequestInit = {
      method: opts.method,
      headers: {
        Authorization: `Bearer ${opts.appToken}`,
        Accept: "application/json",
      },
    };
    const bodylessMethods = new Set(["GET", "HEAD", "DELETE"]);
    if (!bodylessMethods.has(opts.method)) {
      (init as any).body = JSON.stringify(opts.body);
      (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    }
    const res = await fetchWithTimeout(opts.url, init, opts.timeoutMs);
    let body: unknown = null;
    const text = await res.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (res.ok) return { ok: true, data: body };
    return { ok: false, kind: "http", status: res.status, body };
  } catch (err) {
    if ((err as any).name === "AbortError") {
      return { ok: false, kind: "timeout", message: `request exceeded ${opts.timeoutMs}ms` };
    }
    return { ok: false, kind: "network", message: (err as Error).message };
  }
}

export async function invokeApiCallTool(opts: {
  tool: Tool;
  baseUrl: string;
  appToken: string;
  input: Record<string, unknown>;
  defaultTimeoutMs: number;
}): Promise<ToolInvocationResult> {
  if (opts.tool.type !== "api_call") {
    throw new Error(`unsupported tool type: ${(opts.tool as any).type}`);
  }
  const timeoutMs = opts.tool.timeout_ms ?? opts.defaultTimeoutMs;
  let url = opts.baseUrl.replace(/\/$/, "") + opts.tool.endpoint.path;
  const method = opts.tool.endpoint.method;
  if (method === "GET" && Object.keys(opts.input).length > 0) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.input)) {
      if (v === undefined || v === null) continue;
      params.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    const qs = params.toString();
    if (qs) url += (url.includes("?") ? "&" : "?") + qs;
  }

  let attempt = await callOnce({ url, method, body: opts.input, appToken: opts.appToken, timeoutMs });
  // Retry once on 5xx, timeout, or network error.
  const retriable =
    !attempt.ok &&
    (attempt.kind === "timeout" ||
      attempt.kind === "network" ||
      (attempt.kind === "http" && (attempt.status ?? 0) >= 500));
  if (retriable) {
    await Bun.sleep(500);
    attempt = await callOnce({ url, method, body: opts.input, appToken: opts.appToken, timeoutMs });
  }
  if (attempt.ok) return attempt.data;
  if (attempt.kind === "timeout" || attempt.kind === "network") {
    return { error: { kind: attempt.kind, message: attempt.message } };
  }
  return { error: { status: attempt.status, body: attempt.body } };
}
