import { describe, expect, it, vi } from "vitest";
import { createIriguchiChatProxy } from "../src/server/index.js";
import { chunk, controlledStream, DONE, sseResponse } from "./helpers.js";

const options = { gatewayUrl: "http://gateway.internal:4000", apiKey: "sk-iri-secret" };

describe("chat proxy", () => {
  it("attaches the key server-side and forwards the body to the gateway", async () => {
    const fetchImpl = vi.fn(async () => sseResponse([chunk("hi"), DONE]));
    const handle = createIriguchiChatProxy({ ...options, fetchImpl: fetchImpl as never });

    const body = JSON.stringify({ iri_agent: "weather-bot", messages: [], stream: true });
    await handle(new Request("https://app.example/api/ask-ai", { method: "POST", body }));

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://gateway.internal:4000/v1/chat/completions");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer sk-iri-secret");
    expect(init.body).toBe(body);
  });

  it("streams the response through rather than buffering it", async () => {
    const stream = controlledStream();
    const handle = createIriguchiChatProxy({
      ...options,
      fetchImpl: (async () => stream.response) as never,
    });

    const response = await handle(
      new Request("https://app.example/api/ask-ai", { method: "POST", body: "{}" }),
    );
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    stream.push(chunk("first"));
    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain("first");

    stream.push(DONE);
    stream.finish();
    // The first chunk was readable before the upstream stream ended, which is
    // the whole point: nothing waits for the run to finish.
    expect(first.done).toBe(false);
  });

  it("passes a gateway error through with its status and body intact", async () => {
    const failure = JSON.stringify({
      error: { type: "invalid_request_error", code: "invalid_context", message: "not an object" },
    });
    const handle = createIriguchiChatProxy({
      ...options,
      fetchImpl: (async () =>
        new Response(failure, {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })) as never,
    });

    const response = await handle(
      new Request("https://app.example/api/ask-ai", { method: "POST", body: "{}" }),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe(failure);
  });

  it("propagates caller abort to the upstream request", async () => {
    const controller = new AbortController();
    let upstreamSignal: AbortSignal | null = null;
    const handle = createIriguchiChatProxy({
      ...options,
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        upstreamSignal = init?.signal ?? null;
        return sseResponse([DONE]);
      }) as never,
    });

    await handle(
      new Request("https://app.example/api/ask-ai", {
        method: "POST",
        body: "{}",
        signal: controller.signal,
      }),
    );
    controller.abort();

    expect(upstreamSignal).not.toBeNull();
    expect(upstreamSignal!.aborted).toBe(true);
  });

  it("reports an unreachable gateway rather than throwing", async () => {
    const handle = createIriguchiChatProxy({
      ...options,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as never,
    });

    const response = await handle(
      new Request("https://app.example/api/ask-ai", { method: "POST", body: "{}" }),
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "gateway_unreachable" } });
  });

  it("rejects a non-POST request", async () => {
    const handle = createIriguchiChatProxy({ ...options, fetchImpl: (async () => {
      throw new Error("should not be called");
    }) as never });

    const response = await handle(new Request("https://app.example/api/ask-ai"));
    expect(response.status).toBe(405);
  });

  it("tolerates a gateway URL with a trailing slash", async () => {
    const fetchImpl = vi.fn(async () => sseResponse([DONE]));
    const handle = createIriguchiChatProxy({
      gatewayUrl: "http://gateway.internal:4000/",
      apiKey: "k",
      fetchImpl: fetchImpl as never,
    });

    await handle(new Request("https://app.example/api/ask-ai", { method: "POST", body: "{}" }));

    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("http://gateway.internal:4000/v1/chat/completions");
  });
});
