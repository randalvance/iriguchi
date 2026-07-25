import { Hono } from "hono";
import { bearerAuth, generateToken } from "../auth.ts";
import { fetchManifest, ManifestFetchError } from "../registry/manifest.ts";
import type { Config } from "../config.ts";
import type { Store } from "../registry/store.ts";
import type { Logger } from "../logger.ts";
import type { Manifest } from "../registry/schema.ts";

export function registrationRoutes(deps: { config: Config; store: Store; logger: Logger }) {
  const app = new Hono();

  function validateProviders(
    manifest: Manifest,
  ): { ok: true } | { ok: false; agentId: string; provider: string } {
    for (const a of manifest.agents) {
      if (a.provider && !deps.config.providers[a.provider]) {
        return { ok: false, agentId: a.id, provider: a.provider };
      }
    }
    return { ok: true };
  }

  function unknownProviderResponse(check: { agentId: string; provider: string }) {
    return {
      error: {
        type: "invalid_request_error",
        code: "unknown_provider",
        message: `agent "${check.agentId}" references unknown provider "${check.provider}"; configured: [${Object.keys(deps.config.providers).join(", ")}]`,
      },
    };
  }

  const appTokenAuth = bearerAuth({
    resolve: (c) => {
      const id = c.req.param("id");
      const stored = id ? deps.store.getApp(id) : null;
      return stored ? [stored.app_token] : [];
    },
  });

  app.post(
    "/register",
    bearerAuth({ tokens: [deps.config.registrationSecret] }),
    async (c) => {
      let body: any;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: { type: "invalid_request_error", message: "invalid JSON body" } }, 400);
      }
      if (typeof body.id !== "string" || typeof body.base_url !== "string") {
        return c.json({ error: { type: "invalid_request_error", message: "id and base_url are required strings" } }, 400);
      }
      const appToken = generateToken();
      try {
        const manifest = await fetchManifest({ baseUrl: body.base_url, appToken });
        if (manifest.app.id !== body.id) {
          return c.json({ error: { type: "invalid_request_error", message: `manifest app.id (${manifest.app.id}) does not match registration id (${body.id})` } }, 400);
        }
        const check = validateProviders(manifest);
        if (!check.ok) {
          return c.json(unknownProviderResponse(check), 400);
        }
        deps.store.upsertApp({ id: body.id, base_url: body.base_url, app_token: appToken, manifest });
        deps.logger.info("app.register", { app_id: body.id, base_url: body.base_url, agents: manifest.agents.map((a) => a.id) });
        return c.json({ app_token: appToken, accepted_agents: manifest.agents.map((a) => a.id) }, 201);
      } catch (err) {
        if (err instanceof ManifestFetchError) {
          deps.logger.warn("app.register_failed", { app_id: body.id, err: err.message });
          return c.json({ error: { type: "app_unavailable", message: err.message, code: "app_unavailable" } }, 502);
        }
        throw err;
      }
    },
  );

  app.post("/:id/refresh-manifest", appTokenAuth, async (c) => {
    const id = c.req.param("id");
    const stored = deps.store.getApp(id);
    if (!stored) {
      return c.json({ error: { type: "invalid_request_error", message: "app not found" } }, 404);
    }
    try {
      const manifest = await fetchManifest({ baseUrl: stored.base_url, appToken: stored.app_token });
      const check = validateProviders(manifest);
      if (!check.ok) {
        return c.json(unknownProviderResponse(check), 400);
      }
      deps.store.upsertApp({ id, base_url: stored.base_url, app_token: stored.app_token, manifest });
      deps.logger.info("manifest.fetch", { app_id: id, agents: manifest.agents.length });
      return c.json({ accepted_agents: manifest.agents.map((a) => a.id) });
    } catch (err) {
      if (err instanceof ManifestFetchError) {
        return c.json({ error: { type: "app_unavailable", message: err.message, code: "app_unavailable" } }, 502);
      }
      throw err;
    }
  });

  app.delete("/:id", appTokenAuth, (c) => {
    const id = c.req.param("id");
    deps.store.deleteApp(id);
    deps.logger.info("app.deregister", { app_id: id });
    return c.body(null, 204);
  });

  return app;
}
