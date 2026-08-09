/**
 * How a provider expects its credential to be presented to the agent runtime.
 * `api_key` is the Anthropic-native form. `auth_token` is the bearer form used
 * by Anthropic-compatible gateways such as OpenRouter.
 */
export type ProviderAuthStyle = "api_key" | "auth_token";

export const PROVIDER_AUTH_STYLES: readonly ProviderAuthStyle[] = ["api_key", "auth_token"];

export type Provider = {
  name: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  authStyle: ProviderAuthStyle;
};

export type Config = {
  port: number;
  maxAgentTurns: number;
  toolCallTimeoutMs: number;
  manifestCacheTtlMs: number;
  requestTimeoutMs: number;
  mcpCacheTtlMs: number;
  /**
   * Origins an agent manifest may name in an `mcp` entry, normalized to
   * `scheme://host[:port]`. Empty means unrestricted — MCP URLs arrive from
   * registering apps, so this is the only bound on where the gateway will dial
   * out to, but requiring it would break every deployment that predates it.
   */
  mcpAllowedOrigins: string[];
  /**
   * Whether to serve the management UI and the `/internal/*` surface it reads.
   *
   * Defaults to false, and that default is load-bearing rather than cautious.
   * `/internal/*` carries no credential by design, and the container publishes
   * the gateway port; an admin surface that appeared there without being asked
   * for would be the image choosing an exposure on the operator's behalf.
   */
  uiEnabled: boolean;
  /** Directory holding the built UI assets. Only read when `uiEnabled`. */
  uiDist: string;
  dbPath: string;
  tmpDir: string;
  providers: Record<string, Provider>;
  defaultProvider: string;
  apiKey: string;
  registrationSecret: string;
};

const REQUIRED = ["IRI_API_KEY", "IRI_REGISTRATION_SECRET"] as const;

const PROVIDER_KEY_RE = /^IRI_PROVIDER_([A-Z0-9]+)_(API_KEY|BASE_URL|DEFAULT_MODEL|AUTH_STYLE)$/;

function intVar(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`Invalid integer for ${key}: ${raw}`);
  }
  return n;
}

/**
 * Parse a boolean flag.
 *
 * Only the listed spellings are accepted; anything else throws rather than
 * falling back to the default. A typo in a flag that gates an unauthenticated
 * surface must not be able to silently mean "off" *or* "on" — the operator has
 * to be told which one they asked for.
 */
function boolVar(
  env: Record<string, string | undefined>,
  key: string,
  fallback: boolean,
): boolean {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  throw new Error(`Invalid boolean for ${key}: ${raw}; expected true or false`);
}

/**
 * Parse a comma-separated origin allowlist. Entries are normalized through
 * `URL` so that `http://Host:80/path` and `http://host` compare equal to the
 * origin of a declared MCP URL.
 */
function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error(
        `invalid entry in IRI_MCP_ALLOWED_ORIGINS: "${trimmed}"; expected an absolute URL such as http://host:8080`,
      );
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(
        `invalid scheme in IRI_MCP_ALLOWED_ORIGINS entry "${trimmed}": only http and https are supported`,
      );
    }
    if (!out.includes(parsed.origin)) out.push(parsed.origin);
  }
  return out;
}

export function isOriginAllowed(url: string, allowedOrigins: string[]): boolean {
  // A missing allowlist means unrestricted, same as an empty one. Guarding
  // rather than trusting the type keeps a partially-built config from turning
  // an origin check into a crash on the registration path.
  if (!allowedOrigins || allowedOrigins.length === 0) return true;
  try {
    return allowedOrigins.includes(new URL(url).origin);
  } catch {
    return false;
  }
}

function loadProviders(env: Record<string, string | undefined>): Record<string, Provider> {
  const seen: Record<
    string,
    { apiKey?: string; baseUrl?: string; defaultModel?: string; authStyle?: string }
  > = {};
  for (const [key, val] of Object.entries(env)) {
    if (val === undefined || val === "") continue;
    const m = key.match(PROVIDER_KEY_RE);
    if (!m) continue;
    const name = m[1].toLowerCase();
    const field = m[2];
    seen[name] ??= {};
    if (field === "API_KEY") seen[name].apiKey = val;
    else if (field === "BASE_URL") seen[name].baseUrl = val;
    else if (field === "AUTH_STYLE") seen[name].authStyle = val;
    else seen[name].defaultModel = val;
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
    if (!parts.defaultModel) {
      throw new Error(
        `half-configured provider "${name}": missing IRI_PROVIDER_${name.toUpperCase()}_DEFAULT_MODEL`,
      );
    }
    // Absent means api_key, so every provider configured before this option
    // existed resolves exactly as it did.
    const authStyle = parts.authStyle ?? "api_key";
    if (!PROVIDER_AUTH_STYLES.includes(authStyle as ProviderAuthStyle)) {
      throw new Error(
        `invalid IRI_PROVIDER_${name.toUpperCase()}_AUTH_STYLE for provider "${name}": "${authStyle}"; expected one of [${PROVIDER_AUTH_STYLES.join(", ")}]`,
      );
    }
    providers[name] = {
      name,
      apiKey: parts.apiKey,
      baseUrl: parts.baseUrl,
      defaultModel: parts.defaultModel,
      authStyle: authStyle as ProviderAuthStyle,
    };
  }
  if (Object.keys(providers).length === 0) {
    throw new Error(
      "no providers configured; set IRI_PROVIDER_<NAME>_API_KEY, IRI_PROVIDER_<NAME>_BASE_URL, and IRI_PROVIDER_<NAME>_DEFAULT_MODEL",
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
  if (env.IRI_DEFAULT_MODEL) {
    throw new Error(
      "IRI_DEFAULT_MODEL is no longer supported; set IRI_PROVIDER_<NAME>_DEFAULT_MODEL per provider",
    );
  }
  const providers = loadProviders(env);
  const defaultProvider = resolveDefaultProvider(env, providers);
  return {
    port: intVar(env, "IRI_PORT", 4000),
    maxAgentTurns: intVar(env, "IRI_MAX_AGENT_TURNS", 20),
    toolCallTimeoutMs: intVar(env, "IRI_TOOL_CALL_TIMEOUT_MS", 30000),
    manifestCacheTtlMs: intVar(env, "IRI_MANIFEST_CACHE_TTL_MS", 300000),
    requestTimeoutMs: intVar(env, "IRI_REQUEST_TIMEOUT_MS", 300000),
    mcpCacheTtlMs: intVar(env, "IRI_MCP_CACHE_TTL_MS", 300000),
    mcpAllowedOrigins: parseAllowedOrigins(env.IRI_MCP_ALLOWED_ORIGINS),
    uiEnabled: boolVar(env, "IRI_UI_ENABLED", false),
    uiDist: env.IRI_UI_DIST || "./ui/dist",
    dbPath: env.IRI_DB_PATH || "./iriguchi.db",
    tmpDir: env.IRI_TMP_DIR || "./.iri-tmp",
    providers,
    defaultProvider,
    apiKey: env.IRI_API_KEY!,
    registrationSecret: env.IRI_REGISTRATION_SECRET!,
  };
}
