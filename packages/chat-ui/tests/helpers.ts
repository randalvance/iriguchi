import type { StorageLike } from "../src/core/storage.js";

/** An SSE body built from already-known frames. */
export function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
}

export function chunk(text: string): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content: text } }],
  })}\n\n`;
}

export const DONE = "data: [DONE]\n\n";

export function sseResponse(frames: string[]): Response {
  return new Response(sseStream(frames), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/**
 * A stream whose frames are released one at a time, so a test can assert on
 * what the transcript looks like mid-run.
 */
export function controlledStream() {
  const encoder = new TextEncoder();
  let push: (frame: string) => void = () => {};
  let finish: () => void = () => {};
  let fail: (err: Error) => void = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (frame) => controller.enqueue(encoder.encode(frame));
      finish = () => controller.close();
      fail = (err) => controller.error(err);
    },
  });

  return {
    response: new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
    push: (frame: string) => push(frame),
    finish: () => finish(),
    fail: (err: Error) => fail(err),
  };
}

export function memoryStorage(initial: Record<string, string> = {}): StorageLike & {
  readonly map: Map<string, string>;
} {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

/** Awaits a promise expected to reject, and hands back the typed reason. */
export async function rejection<T>(promise: Promise<unknown>): Promise<T> {
  try {
    await promise;
  } catch (err) {
    return err as T;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

/** The request bodies a stubbed `fetch` was called with, parsed. */
export function sentBodies(fetchMock: {
  mock: { calls: unknown[][] };
}): Array<Record<string, unknown>> {
  return fetchMock.mock.calls.map(
    (call) => JSON.parse(String((call[1] as RequestInit | undefined)?.body)) as Record<string, unknown>,
  );
}

/** Lets a test await the microtasks a send fans out into. */
export async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}
