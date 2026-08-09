import { fetchManifest, ManifestFetchError } from "./manifest.ts";
import type { Store } from "./store.ts";
import type { Logger } from "../logger.ts";
import type { Config } from "../config.ts";
import type { McpRuntime } from "../agent/mcp/discovery.ts";
import { refreshStaleMcpTools } from "../agent/mcp/refresh.ts";

export type RefresherHandle = { stop(): void };

export function startBackgroundRefresh(opts: {
  store: Store;
  logger: Logger;
  ttlMs: number;
  intervalMs: number;
  config: Pick<Config, "providers">;
  /** Omit to refresh manifests only. */
  mcp?: McpRuntime;
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
        const bad = manifest.agents.find(
          (a) => a.provider && !opts.config.providers[a.provider],
        );
        if (bad) {
          opts.logger.warn("manifest.refresh_failed", {
            app_id: app.id,
            agent_id: bad.id,
            reason: "unknown_provider",
            provider: bad.provider,
          });
          continue;
        }
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
    if (opts.mcp) {
      await refreshStaleMcpTools(opts.mcp);
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
