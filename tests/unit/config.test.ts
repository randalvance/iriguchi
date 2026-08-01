import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config.ts";

const baseEnv = () => ({
  IRI_API_KEY: "client-key",
  IRI_REGISTRATION_SECRET: "reg-secret",
  IRI_PROVIDER_ANTHROPIC_API_KEY: "ak-anthropic",
  IRI_PROVIDER_ANTHROPIC_BASE_URL: "https://api.anthropic.com",
  IRI_PROVIDER_ANTHROPIC_DEFAULT_MODEL: "claude-opus-5",
});

describe("loadConfig", () => {
  it("returns defaults for optional vars with a single provider", () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.port).toBe(4000);
    expect(cfg.maxAgentTurns).toBe(20);
    expect(cfg.toolCallTimeoutMs).toBe(30000);
    expect(cfg.manifestCacheTtlMs).toBe(300000);
    expect(cfg.requestTimeoutMs).toBe(300000);
    expect(cfg.dbPath).toBe("./iriguchi.db");
    expect(cfg.tmpDir).toBe("./.iri-tmp");
    expect(cfg.apiKey).toBe("client-key");
    expect(cfg.registrationSecret).toBe("reg-secret");
    expect(cfg.providers).toEqual({
      anthropic: {
        name: "anthropic",
        apiKey: "ak-anthropic",
        baseUrl: "https://api.anthropic.com",
        defaultModel: "claude-opus-5",
        authStyle: "api_key",
      },
    });
    expect(cfg.defaultProvider).toBe("anthropic");
    expect("defaultModel" in cfg).toBe(false);
  });

  it("parses multiple providers and honors explicit IRI_DEFAULT_PROVIDER", () => {
    const cfg = loadConfig({
      ...baseEnv(),
      IRI_PROVIDER_OPENROUTER_API_KEY: "sk-or",
      IRI_PROVIDER_OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1/anthropic",
      IRI_PROVIDER_OPENROUTER_DEFAULT_MODEL: "moonshotai/kimi-k3",
      IRI_DEFAULT_PROVIDER: "openrouter",
    });
    expect(Object.keys(cfg.providers).sort()).toEqual(["anthropic", "openrouter"]);
    expect(cfg.providers.openrouter).toEqual({
      name: "openrouter",
      apiKey: "sk-or",
      baseUrl: "https://openrouter.ai/api/v1/anthropic",
      defaultModel: "moonshotai/kimi-k3",
      authStyle: "api_key",
    });
    expect(cfg.defaultProvider).toBe("openrouter");
  });

  it("defaults authStyle to api_key when AUTH_STYLE is unset", () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.providers.anthropic.authStyle).toBe("api_key");
  });

  it("parses an explicit auth_token style", () => {
    const cfg = loadConfig({
      ...baseEnv(),
      IRI_PROVIDER_OPENROUTER_API_KEY: "sk-or",
      IRI_PROVIDER_OPENROUTER_BASE_URL: "https://openrouter.ai/api",
      IRI_PROVIDER_OPENROUTER_DEFAULT_MODEL: "moonshotai/kimi-k3",
      IRI_PROVIDER_OPENROUTER_AUTH_STYLE: "auth_token",
      IRI_DEFAULT_PROVIDER: "openrouter",
    });
    expect(cfg.providers.openrouter.authStyle).toBe("auth_token");
  });

  it("resolves auth styles per provider", () => {
    const cfg = loadConfig({
      ...baseEnv(),
      IRI_PROVIDER_OPENROUTER_API_KEY: "sk-or",
      IRI_PROVIDER_OPENROUTER_BASE_URL: "https://openrouter.ai/api",
      IRI_PROVIDER_OPENROUTER_DEFAULT_MODEL: "moonshotai/kimi-k3",
      IRI_PROVIDER_OPENROUTER_AUTH_STYLE: "auth_token",
      IRI_DEFAULT_PROVIDER: "openrouter",
    });
    expect(cfg.providers.openrouter.authStyle).toBe("auth_token");
    expect(cfg.providers.anthropic.authStyle).toBe("api_key");
  });

  it("throws on an unrecognized auth style, naming the provider and the choices", () => {
    expect(() =>
      loadConfig({ ...baseEnv(), IRI_PROVIDER_ANTHROPIC_AUTH_STYLE: "bearer" }),
    ).toThrow(/anthropic.*bearer.*api_key.*auth_token/is);
  });

  it("does not let AUTH_STYLE alone define a provider", () => {
    // A name seen only via AUTH_STYLE is still half-configured, not a provider.
    expect(() =>
      loadConfig({ ...baseEnv(), IRI_PROVIDER_OPENROUTER_AUTH_STYLE: "auth_token" }),
    ).toThrow(/half-configured provider "openrouter".*API_KEY/i);
  });

  it("lowercases provider names from env-var keys", () => {
    const cfg = loadConfig({
      IRI_API_KEY: "k",
      IRI_REGISTRATION_SECRET: "s",
      IRI_PROVIDER_LMSTUDIO_API_KEY: "lm-studio",
      IRI_PROVIDER_LMSTUDIO_BASE_URL: "http://localhost:1234",
      IRI_PROVIDER_LMSTUDIO_DEFAULT_MODEL: "ornith-1.0-35b",
    });
    expect(cfg.providers.lmstudio).toBeDefined();
    expect(cfg.providers.lmstudio.defaultModel).toBe("ornith-1.0-35b");
    expect(cfg.defaultProvider).toBe("lmstudio");
  });

  it("throws when no providers are configured", () => {
    expect(() =>
      loadConfig({ IRI_API_KEY: "k", IRI_REGISTRATION_SECRET: "s" }),
    ).toThrow(/no providers configured/i);
  });

  it("throws when a provider is missing BASE_URL", () => {
    expect(() =>
      loadConfig({
        IRI_API_KEY: "k",
        IRI_REGISTRATION_SECRET: "s",
        IRI_PROVIDER_ANTHROPIC_API_KEY: "ak",
        IRI_PROVIDER_ANTHROPIC_DEFAULT_MODEL: "claude-opus-5",
      }),
    ).toThrow(/half-configured provider "anthropic".*BASE_URL/i);
  });

  it("throws when a provider is missing API_KEY", () => {
    expect(() =>
      loadConfig({
        IRI_API_KEY: "k",
        IRI_REGISTRATION_SECRET: "s",
        IRI_PROVIDER_ANTHROPIC_BASE_URL: "https://api.anthropic.com",
        IRI_PROVIDER_ANTHROPIC_DEFAULT_MODEL: "claude-opus-5",
      }),
    ).toThrow(/half-configured provider "anthropic".*API_KEY/i);
  });

  it("throws when a provider is missing DEFAULT_MODEL", () => {
    expect(() =>
      loadConfig({
        IRI_API_KEY: "k",
        IRI_REGISTRATION_SECRET: "s",
        IRI_PROVIDER_ANTHROPIC_API_KEY: "ak",
        IRI_PROVIDER_ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      }),
    ).toThrow(/half-configured provider "anthropic".*DEFAULT_MODEL/i);
  });

  it("throws when the legacy IRI_DEFAULT_MODEL is present", () => {
    expect(() =>
      loadConfig({ ...baseEnv(), IRI_DEFAULT_MODEL: "ornith-1.0-35b" }),
    ).toThrow(/IRI_DEFAULT_MODEL is no longer supported.*IRI_PROVIDER_<NAME>_DEFAULT_MODEL/);
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
        IRI_PROVIDER_OPENROUTER_DEFAULT_MODEL: "moonshotai/kimi-k3",
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
