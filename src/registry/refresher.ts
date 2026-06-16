import { fetchManifest, ManifestFetchError } from "./manifest.ts";
import type { Store } from "./store.ts";
import type { Logger } from "../logger.ts";

export type RefresherHandle = { stop(): void };

export function startBackgroundRefresh(opts: {
  store: Store;
  logger: Logger;
  ttlMs: number;
  intervalMs: number;
}): RefresherHandle {
  const tick = async () => {
    const now = Date.now();
    for (const app of opts.store.listApps()) {
      const fetchedAt = app.manifest_fetched_at ?? 0;
      if (now - fetchedAt < opts.ttlMs) continue;
      try {
        const manifest = await fetchManifest({
          baseUrl: app.base_url,
          appToken: app.app_token,
        });
        opts.store.upsertApp({
          id: app.id,
          base_url: app.base_url,
          app_token: app.app_token,
          manifest,
        });
        opts.logger.info("manifest.fetch", { app_id: app.id, stale: true });
      } catch (err) {
        opts.logger.warn("manifest.refresh_failed", {
          app_id: app.id,
          err: err instanceof ManifestFetchError ? err.message : String(err),
        });
      }
    }
  };
  const t = setInterval(() => {
    void tick();
  }, opts.intervalMs);
  return {
    stop() {
      clearInterval(t);
    },
  };
}
