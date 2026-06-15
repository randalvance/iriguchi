import { describe, it, expect, beforeEach } from "bun:test";
import { loadConfig } from "../../src/config.ts";

describe("loadConfig", () => {
  const baseEnv = {
    ANTHROPIC_API_KEY: "ak-test",
    IRI_API_KEY: "client-key",
    IRI_REGISTRATION_SECRET: "reg-secret",
  };

  it("returns defaults for optional vars", () => {
    const cfg = loadConfig(baseEnv);
    expect(cfg.port).toBe(4000);
    expect(cfg.defaultModel).toBe("claude-sonnet-4-6");
    expect(cfg.maxAgentTurns).toBe(20);
    expect(cfg.toolCallTimeoutMs).toBe(30000);
    expect(cfg.manifestCacheTtlMs).toBe(300000);
    expect(cfg.requestTimeoutMs).toBe(300000);
    expect(cfg.dbPath).toBe("./iriguchi.db");
    expect(cfg.tmpDir).toBe("./.iri-tmp");
    expect(cfg.anthropicBaseUrl).toBeUndefined();
    expect(cfg.anthropicApiKey).toBe("ak-test");
    expect(cfg.apiKey).toBe("client-key");
    expect(cfg.registrationSecret).toBe("reg-secret");
  });

  it("honors overrides for optional vars", () => {
    const cfg = loadConfig({
      ...baseEnv,
      IRI_PORT: "5050",
      IRI_DEFAULT_MODEL: "claude-opus-4-8",
      IRI_MAX_AGENT_TURNS: "5",
      IRI_TOOL_CALL_TIMEOUT_MS: "1000",
      IRI_MANIFEST_CACHE_TTL_MS: "60000",
      IRI_REQUEST_TIMEOUT_MS: "120000",
      IRI_DB_PATH: "/tmp/foo.db",
      IRI_TMP_DIR: "/tmp/iri",
      ANTHROPIC_BASE_URL: "http://localhost:11434",
    });
    expect(cfg.port).toBe(5050);
    expect(cfg.defaultModel).toBe("claude-opus-4-8");
    expect(cfg.maxAgentTurns).toBe(5);
    expect(cfg.anthropicBaseUrl).toBe("http://localhost:11434");
  });

  it.each(["ANTHROPIC_API_KEY", "IRI_API_KEY", "IRI_REGISTRATION_SECRET"])(
    "throws if required var %s is missing",
    (name) => {
      const env = { ...baseEnv } as Record<string, string>;
      delete env[name];
      expect(() => loadConfig(env)).toThrow(name);
    },
  );

  it("throws on non-numeric numeric vars", () => {
    expect(() => loadConfig({ ...baseEnv, IRI_PORT: "not-a-number" })).toThrow(
      /IRI_PORT/,
    );
  });
});
