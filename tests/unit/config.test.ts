import { describe, it, expect } from "bun:test";
import { loadConfig } from "../../src/config.ts";

const baseEnv = () => ({
  IRI_API_KEY: "client-key",
  IRI_REGISTRATION_SECRET: "reg-secret",
  IRI_PROVIDER_ANTHROPIC_API_KEY: "ak-anthropic",
  IRI_PROVIDER_ANTHROPIC_BASE_URL: "https://api.anthropic.com",
});

describe("loadConfig", () => {
  it("returns defaults for optional vars with a single provider", () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.port).toBe(4000);
    expect(cfg.defaultModel).toBe("claude-sonnet-4-6");
    expect(cfg.maxAgentTurns).toBe(20);
    expect(cfg.toolCallTimeoutMs).toBe(30000);
    expect(cfg.manifestCacheTtlMs).toBe(300000);
    expect(cfg.requestTimeoutMs).toBe(300000);
    expect(cfg.dbPath).toBe("./iriguchi.db");
    expect(cfg.tmpDir).toBe("./.iri-tmp");
    expect(cfg.apiKey).toBe("client-key");
    expect(cfg.registrationSecret).toBe("reg-secret");
    expect(cfg.providers).toEqual({
      anthropic: { name: "anthropic", apiKey: "ak-anthropic", baseUrl: "https://api.anthropic.com" },
    });
    expect(cfg.defaultProvider).toBe("anthropic");
  });

  it("parses multiple providers and honors explicit IRI_DEFAULT_PROVIDER", () => {
    const cfg = loadConfig({
      ...baseEnv(),
      IRI_PROVIDER_OPENROUTER_API_KEY: "sk-or",
      IRI_PROVIDER_OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1/anthropic",
      IRI_DEFAULT_PROVIDER: "openrouter",
    });
    expect(Object.keys(cfg.providers).sort()).toEqual(["anthropic", "openrouter"]);
    expect(cfg.providers.openrouter).toEqual({
      name: "openrouter",
      apiKey: "sk-or",
      baseUrl: "https://openrouter.ai/api/v1/anthropic",
    });
    expect(cfg.defaultProvider).toBe("openrouter");
  });

  it("lowercases provider names from env-var keys", () => {
    const cfg = loadConfig({
      IRI_API_KEY: "k",
      IRI_REGISTRATION_SECRET: "s",
      IRI_PROVIDER_OPENROUTER_API_KEY: "sk-or",
      IRI_PROVIDER_OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1/anthropic",
    });
    expect(cfg.providers.openrouter).toBeDefined();
    expect(cfg.defaultProvider).toBe("openrouter");
  });

  it("throws when no providers are configured", () => {
    expect(() =>
      loadConfig({ IRI_API_KEY: "k", IRI_REGISTRATION_SECRET: "s" }),
    ).toThrow(/no providers configured/i);
  });

  it("throws when a provider has API_KEY without BASE_URL", () => {
    expect(() =>
      loadConfig({
        IRI_API_KEY: "k",
        IRI_REGISTRATION_SECRET: "s",
        IRI_PROVIDER_ANTHROPIC_API_KEY: "ak",
      }),
    ).toThrow(/half-configured provider "anthropic".*BASE_URL/i);
  });

  it("throws when a provider has BASE_URL without API_KEY", () => {
    expect(() =>
      loadConfig({
        IRI_API_KEY: "k",
        IRI_REGISTRATION_SECRET: "s",
        IRI_PROVIDER_ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      }),
    ).toThrow(/half-configured provider "anthropic".*API_KEY/i);
  });

  it("throws when IRI_DEFAULT_PROVIDER names an unknown provider", () => {
    expect(() =>
      loadConfig({ ...baseEnv(), IRI_DEFAULT_PROVIDER: "openrouter" }),
    ).toThrow(/IRI_DEFAULT_PROVIDER.*"openrouter".*not configured/i);
  });

  it("throws when multiple providers are configured with no IRI_DEFAULT_PROVIDER", () => {
    expect(() =>
      loadConfig({
        ...baseEnv(),
        IRI_PROVIDER_OPENROUTER_API_KEY: "sk-or",
        IRI_PROVIDER_OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1/anthropic",
      }),
    ).toThrow(/multiple providers.*IRI_DEFAULT_PROVIDER unset.*candidates/i);
  });

  it.each(["IRI_API_KEY", "IRI_REGISTRATION_SECRET"])(
    "throws if required var %s is missing",
    (name) => {
      const env: Record<string, string> = { ...baseEnv() };
      delete env[name];
      expect(() => loadConfig(env)).toThrow(name);
    },
  );

  it("honors overrides for optional numeric vars", () => {
    const cfg = loadConfig({
      ...baseEnv(),
      IRI_PORT: "5050",
      IRI_MAX_AGENT_TURNS: "5",
      IRI_TOOL_CALL_TIMEOUT_MS: "1000",
      IRI_MANIFEST_CACHE_TTL_MS: "60000",
      IRI_REQUEST_TIMEOUT_MS: "120000",
    });
    expect(cfg.port).toBe(5050);
    expect(cfg.maxAgentTurns).toBe(5);
    expect(cfg.toolCallTimeoutMs).toBe(1000);
    expect(cfg.manifestCacheTtlMs).toBe(60000);
    expect(cfg.requestTimeoutMs).toBe(120000);
  });

  it("throws on non-numeric numeric vars", () => {
    expect(() => loadConfig({ ...baseEnv(), IRI_PORT: "not-a-number" })).toThrow(
      /IRI_PORT/,
    );
  });
});
