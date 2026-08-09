import { serve } from "@hono/node-server";
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
/** Stand-in for per-user storage; a real app would key this by session. */
const savedLocations = new Set<string>();

const app = new Hono();

const CONDITIONS = ["sunny", "cloudy", "rainy", "windy", "snowy"];

/** Deterministic fake forecast, so the same city always reads the same. */
function forecastFor(location: string, days: number) {
  const seed = [...location].reduce((s, c) => s + c.charCodeAt(0), 0);
  const baseTemp = 50 + (seed % 30);
  return Array.from({ length: days }).map((_, i) => ({
    day: i + 1,
    high_f: baseTemp + ((i * 3) % 10),
    low_f: baseTemp - 10 + ((i * 2) % 8),
    condition: CONDITIONS[(seed + i) % CONDITIONS.length],
  }));
}

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
  // Logged so you can see when the agent actually fetches versus when it reads
  // what was already on screen through get_context.
  console.log(`[weather-app] get_forecast: ${location} (${days}d)`);
  return c.json({ location, days_out: forecastFor(location, days) });
});

// Exposed only while the user is on a city screen, via the tool's `when`
// clause. The gateway never offers it otherwise, so this handler is not a
// second place to enforce that — it just does the work.
app.post("/api/locations", async (c) => {
  if (!appToken || c.req.header("Authorization") !== `Bearer ${appToken}`) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const { city } = (await c.req.json()) as { city?: string };
  if (!city) return c.json({ error: "city required" }, 400);
  savedLocations.add(city);
  console.log(`[weather-app] saved location: ${city}`);
  return c.json({ saved: city, saved_locations: [...savedLocations] });
});

/**
 * What the UI renders — and, verbatim, what it sends as `iri_context`.
 *
 * Deliberately not a tool endpoint. This is the app's own front end calling
 * its own API, so in a real app it would be authenticated by the user's
 * session; the app token exists for the gateway's tool calls and is not
 * something a browser should ever hold. The point of the demo is that this
 * data is *already on screen* by the time the user types, which is why the
 * agent should read it from context instead of fetching it again.
 */
app.get("/api/screen", (c) => {
  const city = c.req.query("city");
  if (!city) {
    return c.json({ route: "/", saved_locations: [...savedLocations] });
  }
  return c.json({
    route: `/city/${city.toLowerCase().replace(/\s+/g, "-")}`,
    city,
    units: "imperial",
    today: new Date().toISOString().slice(0, 10),
    saved_locations: [...savedLocations],
    forecast: forecastFor(city, 7),
  });
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

// Registration waits for the listening callback rather than reading
// server.address() straight after serve(). Binding is asynchronous, so the
// address is null until it completes — and it never completes when the port
// is taken, which is exactly what happens under `node --watch` while the
// previous process is still shutting down. Reading it synchronously turned
// that ordinary restart into a crash loop.
const server = serve({ port: PORT, fetch: app.fetch }, (info) => {
  // WEATHER_PORT=0 asks for an ephemeral port, so advertise the one actually
  // granted rather than a literal 0.
  const selfBaseUrl = process.env.WEATHER_BASE_URL ?? `http://localhost:${info.port}`;
  console.log(`[weather-app] listening on ${selfBaseUrl}`);
  void register(selfBaseUrl);
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[weather-app] port ${PORT} is already in use — another copy is probably ` +
        `still running. Stop it, or set WEATHER_PORT to a free port.`,
    );
  } else {
    console.error(`[weather-app] server error: ${err.message}`);
  }
  process.exit(1);
});
