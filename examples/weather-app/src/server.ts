import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifest } from "./manifest.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.WEATHER_PORT ?? 4001);
const GATEWAY_URL = process.env.IRI_GATEWAY_URL ?? "http://localhost:4000";
const REG_SECRET = process.env.IRI_REGISTRATION_SECRET ?? "";

let appToken: string | null = null;

const app = new Hono();

// Presence-only, and deliberately so: the gateway mints our app token and
// fetches this endpoint with it before registration returns, so at that moment
// we have never seen the token and cannot compare against it. Tightening this
// into an equality check deadlocks registration on every startup. Safe because
// the manifest is metadata only — tool endpoints below do check exactly.
app.get("/agents-manifest", async (c) => {
  const auth = c.req.header("Authorization");
  if (!auth?.startsWith("Bearer ") || auth.length <= 7) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return c.json(await buildManifest());
});

// Tool endpoints return real data and are only called after registration, so
// they verify the app token exactly.
app.post("/api/forecast", async (c) => {
  if (!appToken || c.req.header("Authorization") !== `Bearer ${appToken}`) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const { location, days = 3 } = (await c.req.json()) as {
    location?: string;
    days?: number;
  };
  if (!location) {
    return c.json({ error: "location required" }, 400);
  }
  const seed = [...location].reduce((s, c) => s + c.charCodeAt(0), 0);
  const baseTemp = 50 + (seed % 30);
  const conditions = ["sunny", "cloudy", "rainy", "windy", "snowy"];
  const days_out = Array.from({ length: days }).map((_, i) => ({
    day: i + 1,
    high_f: baseTemp + (i * 3) % 10,
    low_f: baseTemp - 10 + (i * 2) % 8,
    condition: conditions[(seed + i) % conditions.length],
  }));
  return c.json({ location, days_out });
});

app.get("/", async (c) => {
  const html = await readFile(join(__dirname, "..", "public", "index.html"), "utf8");
  return c.html(html);
});

async function register(selfBaseUrl: string) {
  if (!REG_SECRET) {
    console.warn("[weather-app] IRI_REGISTRATION_SECRET unset, skipping registration");
    return;
  }
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(`${GATEWAY_URL}/apps/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${REG_SECRET}` },
        body: JSON.stringify({ id: "weather-app", base_url: selfBaseUrl }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`gateway returned ${res.status}: ${text}`);
      }
      const { app_token, accepted_agents } = (await res.json()) as {
        app_token: string;
        accepted_agents: string[];
      };
      appToken = app_token;
      console.log(`[weather-app] registered, agents: ${accepted_agents.join(", ")}`);
      return;
    } catch (err) {
      console.warn(`[weather-app] registration attempt ${attempt} failed: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  console.error("[weather-app] could not register with gateway after 5 attempts");
}

const server = Bun.serve({ port: PORT, fetch: app.fetch });
// Resolve the base URL only after binding, so WEATHER_PORT=0 (ephemeral port)
// advertises the port we actually got rather than a literal 0.
const selfBaseUrl = process.env.WEATHER_BASE_URL ?? `http://localhost:${server.port}`;
console.log(`[weather-app] listening on ${selfBaseUrl}`);
void register(selfBaseUrl);
