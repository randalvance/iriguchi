import { z } from "zod";

const JsonSchemaObject = z.record(z.string(), z.unknown());

const ApiCallEndpoint = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z
    .string()
    .min(1)
    .refine((p) => p.startsWith("/") && !p.startsWith("//"), {
      message: "endpoint.path must be a relative path starting with '/'",
    }),
});

/**
 * A tool's condition for being exposed at all, matched against the request's
 * `iri_context`.
 *
 * Deliberately four forms and no regex. Manifests arrive through a
 * secret-gated endpoint so they are semi-trusted, but a catastrophically
 * backtracking pattern here would stall tool resolution on every run, and
 * `prefix` already covers the route-hierarchy case that motivates one.
 *
 * Matching is best-effort over whatever keys the client sent — see
 * `matchesWhen` in `src/agent/context.ts`. A clause key naming a path the
 * context does not carry fails every form but `{ exists: false }`.
 */
const WhenScalar = z.union([z.string(), z.number(), z.boolean()]);

const WhenMatcherSchema = z.union([
  WhenScalar,
  z.array(WhenScalar).min(1),
  z.strictObject({ prefix: z.string().min(1) }),
  z.strictObject({ exists: z.boolean() }),
]);

const WhenClauseSchema = z
  .record(z.string().min(1), WhenMatcherSchema)
  // An empty clause would be indistinguishable from no clause at match time
  // but reads as a deliberate restriction, so it is rejected rather than
  // silently treated as "always".
  .refine((w) => Object.keys(w).length > 0, {
    message: "when clause must declare at least one path",
  });

const ApiCallTool = z.object({
  type: z.literal("api_call"),
  when: WhenClauseSchema.optional(),
  name: z.string().min(1),
  description: z.string().min(1),
  parameters: JsonSchemaObject,
  endpoint: ApiCallEndpoint,
  timeout_ms: z.number().int().positive().optional(),
});

/**
 * A reference to an external MCP server, not a tool declaration.
 *
 * Every other member of {@link ToolSchema} describes exactly one tool. This one
 * describes a server the gateway dials out to, and expands at run time into
 * however many tools that server advertises via `tools/list`. Anything walking
 * an agent's `tools` array therefore has to expand before counting.
 *
 * `name` deliberately excludes `_` so the `<name>__<tool>` exposed form can be
 * split back apart on its first `__`.
 */
const McpServerTool = z.object({
  type: z.literal("mcp"),
  // Gates the whole server, not individual tools: discovery is per-server and
  // its tool list is not known until the gateway connects, so a non-matching
  // entry is never dialed at all.
  when: WhenClauseSchema.optional(),
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "mcp server name must be kebab-case"),
  url: z.string().refine(
    (u) => {
      let parsed: URL;
      try {
        parsed = new URL(u);
      } catch {
        return false;
      }
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    },
    { message: "url must be an absolute http or https URL" },
  ),
  headers: z.record(z.string(), z.string()).default({}),
  // Absent means expose everything discovered; an empty array means expose
  // nothing, which is a valid way to park a server without removing it.
  tools: z.array(z.string().min(1)).optional(),
  timeout_ms: z.number().int().positive().optional(),
});

export const ToolSchema = z.discriminatedUnion("type", [ApiCallTool, McpServerTool]);

const SkillSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "skill name must be kebab-case"),
    content: z.string().optional(),
    url: z
      .string()
      .refine(
        (u) => {
          try {
            new URL(u);
            return true;
          } catch {
            return false;
          }
        },
        { message: "url must be a valid URL" },
      )
      .optional(),
  })
  .refine((s) => !!s.content !== !!s.url, {
    message: "skill must have exactly one of content or url",
  });

const AgentSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "agent id must be kebab-case"),
  name: z.string().min(1),
  description: z.string().min(1),
  system_prompt: z.string().min(1),
  default_model: z.string().optional(),
  provider: z.string().min(1).optional(),
  tools: z.array(ToolSchema).default([]),
  skills: z.array(SkillSchema).default([]),
});

export const ManifestSchema = z
  .object({
    manifest_version: z.literal("1"),
    app: z.object({
      id: z
        .string()
        .min(1)
        .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "app id must be kebab-case"),
      name: z.string().min(1),
      description: z.string().min(1),
    }),
    agents: z.array(AgentSchema),
  })
  .refine(
    (m) => new Set(m.agents.map((a) => a.id)).size === m.agents.length,
    { message: "duplicate agent ids within manifest" },
  );

export type Manifest = z.infer<typeof ManifestSchema>;
export type Agent = z.infer<typeof AgentSchema>;
export type Tool = z.infer<typeof ToolSchema>;
export type ApiCallTool = Extract<Tool, { type: "api_call" }>;
export type McpServerTool = Extract<Tool, { type: "mcp" }>;
export type Skill = z.infer<typeof SkillSchema>;
export type WhenMatcher = z.infer<typeof WhenMatcherSchema>;
export type WhenClause = z.infer<typeof WhenClauseSchema>;
