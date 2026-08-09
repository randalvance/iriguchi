import type { Config } from "../config.ts";
import type { Store, StoredApp } from "../registry/store.ts";
import type { Agent, ApiCallTool, McpServerTool } from "../registry/schema.ts";

/**
 * Read models for the internal surface.
 *
 * Every payload here is built field by field from a `StoredApp`. That is the
 * whole point of this module rather than handing route handlers the stored
 * records: `StoredApp.app_token` sits directly beside the manifest, and a
 * single `c.json(app)` would publish it on an endpoint that carries no
 * credential. Declared return types make an accidental widening a type error
 * instead of a leak.
 */

export type AgentSummary = {
  id: string;
  name: string;
  description: string;
  app_id: string;
  app_name: string;
  app_base_url: string;
  provider: string;
  model: string;
  api_call_tool_count: number;
  mcp_server_count: number;
  skill_count: number;
};

export type ApiCallToolView = {
  name: string;
  description: string;
  method: string;
  path: string;
  timeout_ms: number | null;
  parameters: Record<string, unknown>;
};

export type McpServerView = {
  name: string;
  url: string;
  /**
   * Header *names* only. The values may be bearer tokens, and this surface is
   * unauthenticated — see `redactHeaders`.
   */
  header_names: string[];
  /** `null` means expose everything the server advertises. */
  allowed_tools: string[] | null;
  timeout_ms: number | null;
};

export type SkillView = { name: string; source: "inline" | "url" };

export type AgentDetail = AgentSummary & {
  system_prompt: string;
  api_call_tools: ApiCallToolView[];
  mcp_servers: McpServerView[];
  skills: SkillView[];
};

/**
 * Resolve the provider and model an agent will actually run with.
 *
 * Shared with the run path so the catalog cannot drift from it: an agent that
 * omits `provider` or `default_model` inherits them, and reporting the literal
 * absent field would tell an operator "no model" about an agent that runs
 * perfectly well.
 */
export function resolveAgentRouting(
  agent: Pick<Agent, "provider" | "default_model"> | null,
  config: Pick<Config, "providers" | "defaultProvider">,
  requestedModel?: string | null,
): { providerName: string; model: string } {
  const providerName = agent?.provider ?? config.defaultProvider;
  const provider = config.providers[providerName];
  return {
    providerName,
    // A provider named by a manifest but absent from config is a real error on
    // the run path; here it must not break a read, so the declared model or an
    // explicit marker stands in.
    model: requestedModel || agent?.default_model || provider?.defaultModel || "(unresolved)",
  };
}

/** Header names, sorted. Values are never returned by this module. */
function redactHeaders(headers: Record<string, string> | undefined): string[] {
  return Object.keys(headers ?? {}).sort();
}

function summarize(
  app: StoredApp,
  agent: Agent,
  config: Pick<Config, "providers" | "defaultProvider">,
): AgentSummary {
  const { providerName, model } = resolveAgentRouting(agent, config);
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    app_id: app.id,
    app_name: app.manifest?.app.name ?? app.id,
    app_base_url: app.base_url,
    provider: providerName,
    model,
    api_call_tool_count: agent.tools.filter((t) => t.type === "api_call").length,
    // One `mcp` entry is a server, not a tool: it fans out into however many
    // tools that server advertises, which is unknown until discovery. Counting
    // servers is the only honest count available without network I/O.
    mcp_server_count: agent.tools.filter((t) => t.type === "mcp").length,
    skill_count: agent.skills.length,
  };
}

/** Every agent of every app that has a fetched manifest. */
export function listAgentSummaries(
  store: Store,
  config: Pick<Config, "providers" | "defaultProvider">,
): AgentSummary[] {
  return store.listApps().flatMap((app) =>
    // An app registered but never successfully fetched has no agents to show.
    // It is not an error state for this endpoint; it simply contributes none.
    (app.manifest?.agents ?? []).map((agent) => summarize(app, agent, config)),
  );
}

export function findAgent(store: Store, agentId: string): { app: StoredApp; agent: Agent } | null {
  for (const app of store.listApps()) {
    const agent = app.manifest?.agents.find((a) => a.id === agentId);
    if (agent) return { app, agent };
  }
  return null;
}

/** The MCP servers a given agent declares, in manifest order. */
export function agentMcpServers(agent: Agent): McpServerTool[] {
  return agent.tools.filter((t): t is McpServerTool => t.type === "mcp");
}

export function detailAgent(
  app: StoredApp,
  agent: Agent,
  config: Pick<Config, "providers" | "defaultProvider">,
): AgentDetail {
  const apiCall = agent.tools.filter((t): t is ApiCallTool => t.type === "api_call");
  return {
    ...summarize(app, agent, config),
    system_prompt: agent.system_prompt,
    api_call_tools: apiCall.map((t) => ({
      name: t.name,
      description: t.description,
      method: t.endpoint.method,
      path: t.endpoint.path,
      timeout_ms: t.timeout_ms ?? null,
      parameters: t.parameters,
    })),
    mcp_servers: agentMcpServers(agent).map((t) => ({
      name: t.name,
      url: t.url,
      header_names: redactHeaders(t.headers),
      allowed_tools: t.tools ?? null,
      timeout_ms: t.timeout_ms ?? null,
    })),
    // Skill bodies can be large and are not what a catalog is for; the source
    // tells an operator where to look for the content.
    skills: agent.skills.map((s) => ({
      name: s.name,
      source: s.content !== undefined ? ("inline" as const) : ("url" as const),
    })),
  };
}
