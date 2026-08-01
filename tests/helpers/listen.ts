import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";

export type TestServer = {
  port: number;
  /** The handler this server was built from, mirroring Bun's server.fetch. */
  fetch: (req: Request) => Response | Promise<Response>;
  stop(): Promise<void>;
};

type FetchHandler = (req: Request) => Response | Promise<Response>;

type ListenOptions = {
  port?: number;
  fetch: FetchHandler;
  /**
   * Accepted for parity with the Bun.serve call sites. Bun needed a raised
   * idleTimeout to stop it closing SSE sockets mid-response; Node's equivalent
   * is disabling requestTimeout, which is what passing this does.
   */
  idleTimeout?: number;
};

/**
 * Bind a fetch handler to an ephemeral port for the duration of a test.
 *
 * Deliberately mirrors the `Bun.serve({ port: 0, fetch })` signature the suite
 * used before the Node migration, so fixtures keep `server.port` and
 * `server.stop()` and the call sites needed no structural changes.
 */
export function listen(options: ListenOptions): TestServer {
  const server = serve({
    port: options.port ?? 0,
    fetch: options.fetch,
    ...(options.idleTimeout === undefined
      ? {}
      : { serverOptions: { requestTimeout: 0, headersTimeout: 0 } }),
  });
  const { port } = server.address() as AddressInfo;
  let stopped = false;
  return {
    port,
    fetch: options.fetch,
    // Idempotent, because Bun's server.stop() was: some suites stop a server
    // inside a test and again in afterEach, and node's close() errors on the
    // second call rather than ignoring it.
    stop: () =>
      new Promise<void>((resolve, reject) => {
        if (stopped) return resolve();
        stopped = true;
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
