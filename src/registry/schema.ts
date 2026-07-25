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

const ApiCallTool = z.object({
  type: z.literal("api_call"),
  name: z.string().min(1),
  description: z.string().min(1),
  parameters: JsonSchemaObject,
  endpoint: ApiCallEndpoint,
  timeout_ms: z.number().int().positive().optional(),
});

export const ToolSchema = z.discriminatedUnion("type", [ApiCallTool]);

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
export type Skill = z.infer<typeof SkillSchema>;
