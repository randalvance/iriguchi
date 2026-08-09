import { describe, it, expect } from "vitest";
import { ManifestSchema } from "../../src/registry/schema.ts";

const VALID_MANIFEST = {
  manifest_version: "1",
  app: {
    id: "weather-app",
    name: "Weather App",
    description: "Provides weather forecasts and alerts",
  },
  agents: [
    {
      id: "weather-bot",
      name: "Weather Bot",
      description: "Answers weather questions",
      system_prompt: "You are a helpful weather assistant.",
      default_model: "claude-sonnet-4-6",
      tools: [
        {
          type: "api_call",
          name: "get_forecast",
          description: "Get the weather forecast for a location",
          parameters: {
            type: "object",
            properties: {
              location: { type: "string" },
              days: { type: "integer", minimum: 1, maximum: 7 },
            },
            required: ["location"],
          },
          endpoint: { method: "POST", path: "/api/forecast" },
          timeout_ms: 30000,
        },
      ],
      skills: [
        {
          name: "weather-jargon",
          content: "---\nname: weather-jargon\ndescription: jargon\n---\n\nbody",
        },
      ],
    },
  ],
};

describe("ManifestSchema", () => {
  it("accepts a fully populated valid manifest", () => {
    const parsed = ManifestSchema.parse(VALID_MANIFEST);
    expect(parsed.agents[0].id).toBe("weather-bot");
  });

  it("accepts omission of optional agent fields (default_model, tools, skills)", () => {
    const m = structuredClone(VALID_MANIFEST);
    delete (m.agents[0] as any).default_model;
    m.agents[0].tools = [];
    m.agents[0].skills = [];
    expect(() => ManifestSchema.parse(m)).not.toThrow();
  });

  it("accepts url-based skills", () => {
    const m = structuredClone(VALID_MANIFEST);
    m.agents[0].skills = [
      { name: "weather-jargon", url: "https://example.com/skill.md" } as any,
    ];
    expect(() => ManifestSchema.parse(m)).not.toThrow();
  });

  it("rejects skill that has neither content nor url", () => {
    const m = structuredClone(VALID_MANIFEST);
    m.agents[0].skills = [{ name: "broken" } as any];
    expect(() => ManifestSchema.parse(m)).toThrow();
  });

  it("rejects skill that has both content and url", () => {
    const m = structuredClone(VALID_MANIFEST);
    m.agents[0].skills = [
      { name: "x", content: "y", url: "https://z" } as any,
    ];
    expect(() => ManifestSchema.parse(m)).toThrow();
  });

  it("rejects unknown manifest_version", () => {
    const m = structuredClone(VALID_MANIFEST);
    (m as any).manifest_version = "2";
    expect(() => ManifestSchema.parse(m)).toThrow();
  });

  it("rejects tool with unknown type", () => {
    const m = structuredClone(VALID_MANIFEST);
    (m.agents[0].tools[0] as any).type = "shell";
    expect(() => ManifestSchema.parse(m)).toThrow();
  });

  it("rejects external (absolute URL) endpoint paths in api_call tools", () => {
    const m = structuredClone(VALID_MANIFEST);
    m.agents[0].tools[0].endpoint.path = "https://evil.example.com/api";
    expect(() => ManifestSchema.parse(m)).toThrow(/path/i);
  });

  it("rejects missing required fields (agent.id)", () => {
    const m = structuredClone(VALID_MANIFEST);
    delete (m.agents[0] as any).id;
    expect(() => ManifestSchema.parse(m)).toThrow();
  });

  it("rejects duplicate agent ids within a manifest", () => {
    const m = structuredClone(VALID_MANIFEST);
    m.agents.push(structuredClone(m.agents[0]));
    expect(() => ManifestSchema.parse(m)).toThrow(/duplicate/i);
  });

  it("rejects protocol-relative endpoint path", () => {
    const m = structuredClone(VALID_MANIFEST);
    m.agents[0].tools[0].endpoint.path = "//evil.example.com/api";
    expect(() => ManifestSchema.parse(m)).toThrow(/path/i);
  });

  it("rejects endpoint path without leading slash", () => {
    const m = structuredClone(VALID_MANIFEST);
    m.agents[0].tools[0].endpoint.path = "api/forecast";
    expect(() => ManifestSchema.parse(m)).toThrow(/path/i);
  });

  it("rejects ids with trailing hyphen (kebab-case strict)", () => {
    const m = structuredClone(VALID_MANIFEST);
    (m.agents[0] as any).id = "weather-bot-";
    expect(() => ManifestSchema.parse(m)).toThrow();
  });

  it("accepts an agent with an optional provider field", () => {
    const m = structuredClone(VALID_MANIFEST);
    (m.agents[0] as any).provider = "openrouter";
    const parsed = ManifestSchema.parse(m);
    expect(parsed.agents[0].provider).toBe("openrouter");
  });

  it("accepts an agent without a provider field (backward-shape-compatible for manifests)", () => {
    const m = structuredClone(VALID_MANIFEST);
    delete (m.agents[0] as any).provider;
    const parsed = ManifestSchema.parse(m);
    expect(parsed.agents[0].provider).toBeUndefined();
  });

  it("rejects an agent with empty-string provider", () => {
    const m = structuredClone(VALID_MANIFEST);
    (m.agents[0] as any).provider = "";
    expect(() => ManifestSchema.parse(m)).toThrow();
  });
});

const MCP_ENTRY = {
  type: "mcp",
  name: "finance",
  url: "http://finance-mcp.finance-app.svc.cluster.local:8080/mcp",
};

/** VALID_MANIFEST with its agent's tools replaced by the given MCP entry. */
function withMcp(overrides: Record<string, unknown> = {}) {
  const m = structuredClone(VALID_MANIFEST);
  m.agents[0].tools = [{ ...MCP_ENTRY, ...overrides } as any];
  return m;
}

describe("ManifestSchema — mcp tool entries", () => {
  it("accepts a minimal mcp entry", () => {
    const parsed = ManifestSchema.parse(withMcp());
    const tool = parsed.agents[0].tools[0];
    expect(tool.type).toBe("mcp");
  });

  it("accepts an agent declaring both api_call and mcp entries", () => {
    const m = structuredClone(VALID_MANIFEST);
    m.agents[0].tools.push(MCP_ENTRY as any);
    const parsed = ManifestSchema.parse(m);
    expect(parsed.agents[0].tools.map((t) => t.type)).toEqual(["api_call", "mcp"]);
  });

  it("defaults headers to an empty object and leaves tools/timeout_ms unset", () => {
    const parsed = ManifestSchema.parse(withMcp());
    const tool = parsed.agents[0].tools[0];
    if (tool.type !== "mcp") throw new Error("expected mcp tool");
    expect(tool.headers).toEqual({});
    expect(tool.tools).toBeUndefined();
    expect(tool.timeout_ms).toBeUndefined();
  });

  it("preserves declared headers, tools allowlist, and timeout_ms", () => {
    const parsed = ManifestSchema.parse(
      withMcp({
        headers: { "X-Example": "value" },
        tools: ["list_accounts"],
        timeout_ms: 5000,
      }),
    );
    const tool = parsed.agents[0].tools[0];
    if (tool.type !== "mcp") throw new Error("expected mcp tool");
    expect(tool.headers).toEqual({ "X-Example": "value" });
    expect(tool.tools).toEqual(["list_accounts"]);
    expect(tool.timeout_ms).toBe(5000);
  });

  it("accepts an empty tools allowlist as a way to park a server", () => {
    const parsed = ManifestSchema.parse(withMcp({ tools: [] }));
    const tool = parsed.agents[0].tools[0];
    if (tool.type !== "mcp") throw new Error("expected mcp tool");
    expect(tool.tools).toEqual([]);
  });

  it("rejects a server name containing an underscore", () => {
    // Underscores would make the `<server>__<tool>` split ambiguous.
    expect(() => ManifestSchema.parse(withMcp({ name: "finance_mcp" }))).toThrow(/kebab-case/i);
  });

  it("rejects an uppercase server name", () => {
    expect(() => ManifestSchema.parse(withMcp({ name: "Finance" }))).toThrow(/kebab-case/i);
  });

  it("rejects a relative url", () => {
    expect(() => ManifestSchema.parse(withMcp({ url: "/mcp" }))).toThrow(/url/i);
  });

  it("rejects an unparseable url", () => {
    expect(() => ManifestSchema.parse(withMcp({ url: "not a url" }))).toThrow(/url/i);
  });

  it("rejects a non-http scheme", () => {
    expect(() => ManifestSchema.parse(withMcp({ url: "ftp://example.com/mcp" }))).toThrow(/url/i);
  });

  it("accepts https as well as http", () => {
    expect(() => ManifestSchema.parse(withMcp({ url: "https://example.com/mcp" }))).not.toThrow();
  });
});

/** Put a `when` clause on the manifest's `api_call` tool. */
function withWhen(when: unknown) {
  const m = structuredClone(VALID_MANIFEST);
  (m.agents[0].tools[0] as any).when = when;
  return m;
}

describe("ManifestSchema — when clauses", () => {
  it("accepts a manifest with no when clauses at all", () => {
    const parsed = ManifestSchema.parse(VALID_MANIFEST);
    expect((parsed.agents[0].tools[0] as any).when).toBeUndefined();
  });

  it.each([
    ["scalar string", { route: "/imports/preview" }],
    ["scalar number", { count: 47 }],
    ["scalar boolean", { live: true }],
    ["array membership", { route: ["/imports/preview", "/imports/review"] }],
    ["prefix", { route: { prefix: "/accounts/" } }],
    ["exists", { import_batch_id: { exists: true } }],
    ["multiple entries", { route: "/x", batch: { exists: true } }],
    ["nested path key", { "screen.name": "preview" }],
  ])("accepts a %s matcher", (_label, when) => {
    const parsed = ManifestSchema.parse(withWhen(when));
    expect((parsed.agents[0].tools[0] as any).when).toEqual(when);
  });

  it("accepts a when clause on an mcp entry", () => {
    const parsed = ManifestSchema.parse(withMcp({ when: { route: { prefix: "/accounts/" } } }));
    const tool = parsed.agents[0].tools[0];
    if (tool.type !== "mcp") throw new Error("expected mcp tool");
    expect(tool.when).toEqual({ route: { prefix: "/accounts/" } });
  });

  it("rejects an empty clause, which reads as a restriction but never restricts", () => {
    expect(() => ManifestSchema.parse(withWhen({}))).toThrow(/at least one path/i);
  });

  it("rejects an empty path key", () => {
    expect(() => ManifestSchema.parse(withWhen({ "": "x" }))).toThrow();
  });

  it.each([
    ["an unrecognized matcher form", { route: { regex: "^/acc" } }],
    ["a matcher with an extra key", { route: { prefix: "/a", exists: true } }],
    ["a non-object clause", "route=/imports/preview"],
    ["an array clause", [{ route: "/x" }]],
    ["a null matcher", { route: null }],
    ["a nested-object matcher", { route: { a: { b: 1 } } }],
    ["an empty array matcher", { route: [] }],
    ["a non-scalar array member", { route: [{ a: 1 }] }],
    ["a non-string prefix", { route: { prefix: 4 } }],
    ["an empty prefix", { route: { prefix: "" } }],
    ["a non-boolean exists", { route: { exists: "yes" } }],
  ])("rejects %s", (_label, when) => {
    expect(() => ManifestSchema.parse(withWhen(when))).toThrow();
  });

  it("rejects the whole manifest atomically, not just the offending tool", () => {
    const m = structuredClone(VALID_MANIFEST);
    m.agents[0].tools.push({ ...(m.agents[0].tools[0] as any), name: "other_tool" });
    (m.agents[0].tools[1] as any).when = { route: { regex: "^/x" } };
    expect(() => ManifestSchema.parse(m)).toThrow();
  });
});
