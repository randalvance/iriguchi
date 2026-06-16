import { Hono } from "hono";
import { bearerAuth } from "../auth.ts";
import type { Config } from "../config.ts";

export function openaiRoutes(deps: { config: Config }) {
  const app = new Hono();
  app.use("*", bearerAuth({ tokens: [deps.config.apiKey] }));

  app.get("/models", (c) => {
    const created = Math.floor(Date.now() / 1000);
    const allowed = [deps.config.defaultModel, "claude-opus-4-8", "claude-haiku-4-5"];
    return c.json({
      object: "list",
      data: allowed.map((id) => ({
        id,
        object: "model",
        created,
        owned_by: "iriguchi",
      })),
    });
  });

  return app;
}
