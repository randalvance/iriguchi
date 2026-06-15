import { ManifestSchema, type Manifest } from "./schema.ts";

export class ManifestFetchError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ManifestFetchError";
  }
}

export async function fetchManifest(opts: {
  baseUrl: string;
  appToken: string;
  timeoutMs?: number;
}): Promise<Manifest> {
  const url = new URL("/agents-manifest", opts.baseUrl).toString();
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10000);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${opts.appToken}`, Accept: "application/json" },
      signal: ctrl.signal,
    });
  } catch (err) {
    const isAbort = err instanceof DOMException && err.name === "AbortError";
    const timeoutMs = opts.timeoutMs ?? 10000;
    throw new ManifestFetchError(
      isAbort
        ? `timeout after ${timeoutMs}ms fetching ${url}`
        : `network error fetching ${url}`,
      err,
    );
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) {
    throw new ManifestFetchError(`HTTP ${res.status} from ${url}`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new ManifestFetchError(`invalid JSON from ${url}`, err);
  }
  const parsed = ManifestSchema.safeParse(body);
  if (!parsed.success) {
    throw new ManifestFetchError(
      `manifest validation failed: ${parsed.error.message}`,
      parsed.error,
    );
  }
  return parsed.data;
}
