import { describe, it, expect } from "vitest";
import { providerCredentialEnv } from "../../src/agent/runner.ts";
import type { Provider } from "../../src/config.ts";

function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    name: "p",
    apiKey: "provider-key",
    baseUrl: "https://provider.example",
    defaultModel: "some-model",
    authStyle: "api_key",
    ...overrides,
  };
}

describe("providerCredentialEnv", () => {
  it("exports the key as ANTHROPIC_API_KEY for api_key providers", () => {
    const env = providerCredentialEnv(provider());
    expect(env.ANTHROPIC_API_KEY).toBe("provider-key");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://provider.example");
    expect("ANTHROPIC_AUTH_TOKEN" in env).toBe(false);
  });

  it("exports the key as ANTHROPIC_AUTH_TOKEN for auth_token providers", () => {
    const env = providerCredentialEnv(provider({ authStyle: "auth_token" }));
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("provider-key");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://provider.example");
  });

  it("blanks ANTHROPIC_API_KEY for auth_token providers — present, not omitted", () => {
    const env = providerCredentialEnv(provider({ authStyle: "auth_token" }));
    // Presence is the assertion that matters. `toBeFalsy()` would also pass if
    // the key were omitted entirely, which is the dangerous case: with no value
    // the SDK authenticates against Anthropic directly instead of the provider.
    expect("ANTHROPIC_API_KEY" in env).toBe(true);
    expect(env.ANTHROPIC_API_KEY).toBe("");
  });

  it("overrides an ambient ANTHROPIC_API_KEY when spread over the environment", () => {
    const ambient: Record<string, string> = {
      ANTHROPIC_API_KEY: "operators-own-key",
      PATH: "/usr/bin",
    };
    const merged = { ...ambient, ...providerCredentialEnv(provider({ authStyle: "auth_token" })) };
    expect(merged.ANTHROPIC_API_KEY).toBe("");
    expect(merged.ANTHROPIC_AUTH_TOKEN).toBe("provider-key");
    expect(merged.PATH).toBe("/usr/bin");
  });

  it("never leaks one provider's credential into another's environment", () => {
    const local = providerCredentialEnv(
      provider({ name: "lmstudio", apiKey: "lm-key", baseUrl: "http://localhost:1234" }),
    );
    const remote = providerCredentialEnv(
      provider({
        name: "openrouter",
        apiKey: "sk-or-secret",
        baseUrl: "https://openrouter.ai/api",
        authStyle: "auth_token",
      }),
    );
    expect(JSON.stringify(local)).not.toContain("sk-or-secret");
    expect(JSON.stringify(remote)).not.toContain("lm-key");
    expect(local.ANTHROPIC_BASE_URL).toBe("http://localhost:1234");
    expect(remote.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
  });
});
