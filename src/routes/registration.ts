import { Hono } from "hono";
import { bearerAuth, generateToken } from "../auth.ts";
import { fetchManifest, ManifestFetchError } from "../registry/manifest.ts";
import type { Config } from "../config.ts";
import { isOriginAllowed } from "../config.ts";
import type { Store } from "../registry/store.ts";
import type { Logger } from "../logger.ts";
import type { Manifest } from "../registry/schema.ts";
import { GET_CONTEXT_TOOL_NAME } from "../agent/context.ts";

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

  /**
   * The origin check the schema cannot do: `ToolSchema` already rejects a
   * malformed or non-HTTP `url`, but the allowlist is gateway config rather
   * than manifest content.
   *
   * Deliberately does not connect. An `mcp` entry is a reference, so its tool
   * surface is unknown until a run needs it; a server that happens to be down
   * at registration time is not a registration failure.
   */
  function validateMcpEntries(
    manifest: Manifest,
  ): { ok: true } | { ok: false; agentId: string; server: string; url: string } {
    if (!deps.config.mcpAllowedOrigins?.length) return { ok: true };
    for (const a of manifest.agents) {
      for (const t of a.tools) {
        if (t.type !== "mcp") continue;
        if (!isOriginAllowed(t.url, deps.config.mcpAllowedOrigins)) {
          return { ok: false, agentId: a.id, server: t.name, url: t.url };
        }
      }
    }
    return { ok: true };
  }

  /**
   * The gateway serves its own `get_context` tool on the same tool surface, so
   * an `api_call` of that name would be shadowed with no diagnosis at run
   * time. `mcp` entries are exempt: their tools reach the model prefixed by
   * the server name (`finance__get_context`) and cannot collide.
   */
  function validateReservedToolNames(
    manifest: Manifest,
  ): { ok: true } | { ok: false; agentId: string; tool: string } {
    for (const a of manifest.agents) {
      for (const t of a.tools) {
        if (t.type === "api_call" && t.name === GET_CONTEXT_TOOL_NAME) {
          return { ok: false, agentId: a.id, tool: t.name };
        }
      }
    }
    return { ok: true };
  }

  function reservedToolNameResponse(check: { agentId: string; tool: string }) {
    return {
      error: {
        type: "invalid_request_error",
        code: "reserved_tool_name",
        message: `agent "${check.agentId}" declares an api_call tool named "${check.tool}", which is reserved: the gateway exposes its own "${GET_CONTEXT_TOOL_NAME}" tool for reading the request's iri_context. Rename the tool.`,
      },
    };
  }

  function disallowedMcpOriginResponse(check: {
    agentId: string;
    server: string;
    url: string;
  }) {
    return {
      error: {
        type: "invalid_request_error",
        code: "mcp_origin_not_allowed",
        message: `agent "${check.agentId}" declares mcp server "${check.server}" at url "${check.url}", whose origin is not permitted; allowed origins: [${deps.config.mcpAllowedOrigins.join(", ")}]`,
      },
    };
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

  /**
   * The gateway mints an app token and presents it on the very next manifest
   * fetch, so during initial registration the app cannot possibly recognize
   * it. An app that gates `GET /agents-manifest` on token equality therefore
   * deadlocks its own registration. A bare `app_unavailable` reads as "your
   * app is down", so 401/403 gets its own code and an actionable message.
   */
  function manifestFetchErrorResponse(err: ManifestFetchError) {
    if (err.status === 401 || err.status === 403) {
      return {
        body: {
          error: {
            type: "app_unavailable",
            code: "manifest_unauthorized",
            message:
              `your app rejected the gateway's credentials on GET /agents-manifest (${err.message}). ` +
              "The gateway mints your app token immediately before this fetch and only returns it once " +
              "registration succeeds, so your app cannot know the token yet. GET /agents-manifest must " +
              "accept any non-empty Bearer token — it serves only agent metadata. Keep exact app-token " +
              "equality on your tool endpoints, which do carry app data.",
          },
        },
        code: "manifest_unauthorized" as const,
      };
    }
    return {
      body: {
        error: { type: "app_unavailable", message: err.message, code: "app_unavailable" },
      },
      code: "app_unavailable" as const,
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
        const mcpCheck = validateMcpEntries(manifest);
        if (!mcpCheck.ok) {
          return c.json(disallowedMcpOriginResponse(mcpCheck), 400);
        }
        const reservedCheck = validateReservedToolNames(manifest);
        if (!reservedCheck.ok) {
          return c.json(reservedToolNameResponse(reservedCheck), 400);
        }
        deps.store.upsertApp({ id: body.id, base_url: body.base_url, app_token: appToken, manifest });
        deps.logger.info("app.register", { app_id: body.id, base_url: body.base_url, agents: manifest.agents.map((a) => a.id) });
        return c.json({ app_token: appToken, accepted_agents: manifest.agents.map((a) => a.id) }, 201);
      } catch (err) {
        if (err instanceof ManifestFetchError) {
          const mapped = manifestFetchErrorResponse(err);
          deps.logger.warn("app.register_failed", {
            app_id: body.id,
            err: err.message,
            code: mapped.code,
            upstream_status: err.status ?? null,
          });
          return c.json(mapped.body, 502);
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
      const mcpCheck = validateMcpEntries(manifest);
      if (!mcpCheck.ok) {
        return c.json(disallowedMcpOriginResponse(mcpCheck), 400);
      }
      const reservedCheck = validateReservedToolNames(manifest);
      if (!reservedCheck.ok) {
        return c.json(reservedToolNameResponse(reservedCheck), 400);
      }
      deps.store.upsertApp({ id, base_url: stored.base_url, app_token: stored.app_token, manifest });
      deps.logger.info("manifest.fetch", { app_id: id, agents: manifest.agents.length });
      return c.json({ accepted_agents: manifest.agents.map((a) => a.id) });
    } catch (err) {
      if (err instanceof ManifestFetchError) {
        const mapped = manifestFetchErrorResponse(err);
        deps.logger.warn("manifest.fetch_failed", {
          app_id: id,
          err: err.message,
          code: mapped.code,
          upstream_status: err.status ?? null,
        });
        return c.json(mapped.body, 502);
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
