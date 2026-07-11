export type Provider = {
  name: string;
  baseUrl: string;
  apiKey: string;
};

export type Config = {
  port: number;
  defaultModel: string;
  maxAgentTurns: number;
  toolCallTimeoutMs: number;
  manifestCacheTtlMs: number;
  requestTimeoutMs: number;
  dbPath: string;
  tmpDir: string;
  providers: Record<string, Provider>;
  defaultProvider: string;
  apiKey: string;
  registrationSecret: string;
};

const REQUIRED = ["IRI_API_KEY", "IRI_REGISTRATION_SECRET"] as const;

const PROVIDER_KEY_RE = /^IRI_PROVIDER_([A-Z0-9]+)_(API_KEY|BASE_URL)$/;

function intVar(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`Invalid integer for ${key}: ${raw}`);
  }
  return n;
}

function loadProviders(env: Record<string, string | undefined>): Record<string, Provider> {
  const seen: Record<string, { apiKey?: string; baseUrl?: string }> = {};
  for (const [key, val] of Object.entries(env)) {
    if (val === undefined || val === "") continue;
    const m = key.match(PROVIDER_KEY_RE);
    if (!m) continue;
    const name = m[1].toLowerCase();
    const field = m[2];
    seen[name] ??= {};
    if (field === "API_KEY") seen[name].apiKey = val;
    else seen[name].baseUrl = val;
  }
  const providers: Record<string, Provider> = {};
  for (const [name, parts] of Object.entries(seen)) {
    if (!parts.apiKey) {
      throw new Error(
        `half-configured provider "${name}": missing IRI_PROVIDER_${name.toUpperCase()}_API_KEY`,
      );
    }
    if (!parts.baseUrl) {
      throw new Error(
        `half-configured provider "${name}": missing IRI_PROVIDER_${name.toUpperCase()}_BASE_URL`,
      );
    }
    providers[name] = { name, apiKey: parts.apiKey, baseUrl: parts.baseUrl };
  }
  if (Object.keys(providers).length === 0) {
    throw new Error(
      "no providers configured; set IRI_PROVIDER_<NAME>_API_KEY and IRI_PROVIDER_<NAME>_BASE_URL",
    );
  }
  return providers;
}

function resolveDefaultProvider(
  env: Record<string, string | undefined>,
  providers: Record<string, Provider>,
): string {
  const explicit = env.IRI_DEFAULT_PROVIDER;
  if (explicit) {
    if (!providers[explicit]) {
      throw new Error(
        `IRI_DEFAULT_PROVIDER names "${explicit}" but that provider is not configured; candidates: [${Object.keys(providers).join(", ")}]`,
      );
    }
    return explicit;
  }
  const names = Object.keys(providers);
  if (names.length === 1) return names[0];
  throw new Error(
    `multiple providers configured but IRI_DEFAULT_PROVIDER unset; candidates: [${names.join(", ")}]`,
  );
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  for (const name of REQUIRED) {
    if (!env[name]) throw new Error(`Missing required env var: ${name}`);
  }
  const providers = loadProviders(env);
  const defaultProvider = resolveDefaultProvider(env, providers);
  return {
    port: intVar(env, "IRI_PORT", 4000),
    defaultModel: env.IRI_DEFAULT_MODEL || "claude-sonnet-4-6",
    maxAgentTurns: intVar(env, "IRI_MAX_AGENT_TURNS", 20),
    toolCallTimeoutMs: intVar(env, "IRI_TOOL_CALL_TIMEOUT_MS", 30000),
    manifestCacheTtlMs: intVar(env, "IRI_MANIFEST_CACHE_TTL_MS", 300000),
    requestTimeoutMs: intVar(env, "IRI_REQUEST_TIMEOUT_MS", 300000),
    dbPath: env.IRI_DB_PATH || "./iriguchi.db",
    tmpDir: env.IRI_TMP_DIR || "./.iri-tmp",
    providers,
    defaultProvider,
    apiKey: env.IRI_API_KEY!,
    registrationSecret: env.IRI_REGISTRATION_SECRET!,
  };
}
