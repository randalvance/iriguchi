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
          "You are a helpful weather assistant. When a user asks about weather, use the get_forecast tool with the location they mention. Then answer in plain language using the data returned. If you reference jargon, briefly explain it.",
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
        ],
        skills: [
          { name: "weather-jargon", content: skillBody },
        ],
      },
    ],
  };
}
