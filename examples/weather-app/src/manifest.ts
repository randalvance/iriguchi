import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function buildManifest() {
  const skillBody = await readFile(
    join(__dirname, "..", "skills", "weather-jargon.md"),
    "utf8",
  );
  return {
    manifest_version: "1",
    app: {
      id: "weather-app",
      name: "Weather App",
      description: "Demo app exposing a weather forecast agent.",
    },
    agents: [
      {
        id: "weather-bot",
        name: "Weather Bot",
        description: "Answers questions about current and forecast weather.",
        system_prompt:
          "You are a helpful weather assistant. " +
          "If a context block describes the screen the user is viewing, prefer it over " +
          "fetching again: the forecast shown there is already loaded, so read it with " +
          "get_context rather than calling get_forecast for the same city. " +
          "Use get_forecast when the user asks about a city that is not the one on screen. " +
          "Answer in plain language using the data returned. If you reference jargon, briefly explain it.",
        tools: [
          {
            type: "api_call" as const,
            name: "get_forecast",
            description: "Get a fake but plausible weather forecast for a location.",
            parameters: {
              type: "object",
              properties: {
                location: { type: "string", description: "City name" },
                days: { type: "integer", minimum: 1, maximum: 7, default: 3 },
              },
              required: ["location"],
            },
            endpoint: { method: "POST" as const, path: "/api/forecast" },
          },
          {
            // Only meaningful while the user is looking at a city, so it is
            // exposed only then. `when` is matched against the request's
            // iri_context; with no city selected the UI sends route "/", the
            // prefix does not match, and the model never sees this tool.
            type: "api_call" as const,
            name: "save_location",
            description:
              "Save the city the user is currently viewing to their saved locations.",
            parameters: {
              type: "object",
              properties: {
                city: { type: "string", description: "City name to save" },
              },
              required: ["city"],
            },
            endpoint: { method: "POST" as const, path: "/api/locations" },
            when: { route: { prefix: "/city/" } },
          },
        ],
        skills: [
          { name: "weather-jargon", content: skillBody },
        ],
      },
    ],
  };
}
