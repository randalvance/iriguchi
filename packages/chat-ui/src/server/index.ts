export interface ChatProxyOptions {
  /** Base URL of the Iriguchi gateway, e.g. `http://localhost:4000`. */
  gatewayUrl: string;
  /** The gateway's `IRI_API_KEY`. Server-side only — never ship it to a browser. */
  apiKey: string;
  /** Overrides the upstream path. Defaults to the OpenAI-compatible endpoint. */
  path?: string;
  fetchImpl?: typeof fetch;
}

export type ChatProxyHandler = (request: Request) => Promise<Response>;

// Headers that describe the hop rather than the payload; forwarding them
// breaks streaming through a second server.
const HOP_BY_HOP = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "transfer-encoding",
]);

function json(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { type: "invalid_request_error", code, message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * A `Request -> Response` handler the host mounts on its own origin. It exists
 * for exactly one reason: the browser must never hold the gateway key.
 *
 * It is deliberately dumb — it does not parse SSE, inspect the body, or
 * enforce policy. Anything it understood would be a second place to keep in
 * sync with the gateway's contract.
 *
 * Next.js App Router accepts it directly:
 *   export const POST = createIriguchiChatProxy({ ... })
 */
export function createIriguchiChatProxy(options: ChatProxyOptions): ChatProxyHandler {
  const doFetch = options.fetchImpl ?? fetch;
  const upstream =
    options.gatewayUrl.replace(/\/+$/, "") + (options.path ?? "/v1/chat/completions");

  return async function handle(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return json(405, "method_not_allowed", "this endpoint accepts POST");
    }

    const body = await request.text();

    let response: Response;
    try {
      response = await doFetch(upstream, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.apiKey}`,
        },
        body,
        // So a browser that aborts mid-stream aborts the run upstream rather
        // than leaving the gateway talking to nobody.
        signal: request.signal,
      });
    } catch (cause) {
      if (request.signal.aborted) {
        return new Response(null, { status: 499 });
      }
      return json(
        502,
        "gateway_unreachable",
        cause instanceof Error ? cause.message : "could not reach the gateway",
      );
    }

    const headers = new Headers();
    for (const [name, value] of response.headers) {
      if (!HOP_BY_HOP.has(name.toLowerCase())) headers.set(name, value);
    }
    // Some proxies buffer event streams unless told not to.
    if (headers.get("content-type")?.includes("text/event-stream") === true) {
      headers.set("Cache-Control", "no-cache, no-transform");
      headers.set("X-Accel-Buffering", "no");
    }

    // The body is passed through as a stream: status and payload reach the
    // browser exactly as the gateway produced them, chunk by chunk.
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}
