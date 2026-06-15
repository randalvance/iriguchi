export type Config = {
  port: number;
  defaultModel: string;
  maxAgentTurns: number;
  toolCallTimeoutMs: number;
  manifestCacheTtlMs: number;
  requestTimeoutMs: number;
  dbPath: string;
  tmpDir: string;
  anthropicApiKey: string;
  anthropicBaseUrl: string | undefined;
  apiKey: string;
  registrationSecret: string;
};

const REQUIRED = ["ANTHROPIC_API_KEY", "IRI_API_KEY", "IRI_REGISTRATION_SECRET"] as const;

function intVar(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`Invalid integer for ${key}: ${raw}`);
  }
  return n;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  for (const name of REQUIRED) {
    if (!env[name]) throw new Error(`Missing required env var: ${name}`);
  }
  return {
    port: intVar(env, "IRI_PORT", 4000),
    defaultModel: env.IRI_DEFAULT_MODEL || "claude-sonnet-4-6",
    maxAgentTurns: intVar(env, "IRI_MAX_AGENT_TURNS", 20),
    toolCallTimeoutMs: intVar(env, "IRI_TOOL_CALL_TIMEOUT_MS", 30000),
    manifestCacheTtlMs: intVar(env, "IRI_MANIFEST_CACHE_TTL_MS", 300000),
    requestTimeoutMs: intVar(env, "IRI_REQUEST_TIMEOUT_MS", 300000),
    dbPath: env.IRI_DB_PATH || "./iriguchi.db",
    tmpDir: env.IRI_TMP_DIR || "./.iri-tmp",
    anthropicApiKey: env.ANTHROPIC_API_KEY!,
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL || undefined,
    apiKey: env.IRI_API_KEY!,
    registrationSecret: env.IRI_REGISTRATION_SECRET!,
  };
}
