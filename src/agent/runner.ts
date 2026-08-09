import { ulid } from "ulid";
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { Config, Provider } from "../config.ts";
import type { Store, AgentLookup } from "../registry/store.ts";
import type { Tool, Agent } from "../registry/schema.ts";
import { materializeSkills } from "./skills.ts";
import { invokeTool } from "./tools.ts";
import { expandAgentTools, type McpRuntime, type ResolvedMcpTool } from "./mcp/discovery.ts";
import { jsonSchemaToZodRawShape } from "./json-schema-to-zod.ts";
import {
  translateSdkEvent,
  formatSseChunk,
  createTranslateContext,
  DONE_SENTINEL,
  type SdkEvent,
  type OpenAIChunk,
} from "./openai-sse.ts";

const GENERIC_SYSTEM_PROMPT = "You are a helpful general-purpose assistant.";

export class GatewayError extends Error {
  // Declared and assigned explicitly rather than as constructor parameter
  // properties: Node runs these sources by stripping types, and parameter
  // properties are not erasable syntax.
  httpStatus: number;
  type: string;
  code?: string;

  constructor(httpStatus: number, type: string, message: string, code?: string) {
    super(message);
    this.httpStatus = httpStatus;
    this.type = type;
    this.code = code;
  }
}

export type ChatRequest = {
  requestId: string;
  agentId: string | null;
  model: string | null;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  showToolCalls: boolean;
};

/**
 * The credential variables handed to the agent runtime for a given provider.
 *
 * `auth_token` providers — OpenRouter's Anthropic surface, for one — carry the
 * key in `ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_API_KEY` must be present but
 * empty. Omitting it is NOT equivalent and is not a tidy-up opportunity: with
 * no value at all the SDK falls back to authenticating against Anthropic
 * directly, silently bypassing the configured provider and billing elsewhere.
 * Returning it explicitly also means it overwrites any ambient
 * `ANTHROPIC_API_KEY` when spread over `process.env`.
 */
export function providerCredentialEnv(provider: Provider): Record<string, string> {
  if (provider.authStyle === "auth_token") {
    return {
      ANTHROPIC_AUTH_TOKEN: provider.apiKey,
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_BASE_URL: provider.baseUrl,
    };
  }
  return {
    ANTHROPIC_API_KEY: provider.apiKey,
    ANTHROPIC_BASE_URL: provider.baseUrl,
  };
}

export type RunnerOpts = {
  config: Pick<
    Config,
    "tmpDir" | "maxAgentTurns" | "toolCallTimeoutMs" | "providers" | "defaultProvider"
  >;
  store: Store;
  request: ChatRequest;
  /**
   * Shared MCP connection pool and tool cache. Absent means the gateway runs
   * with no MCP support at all, and `mcp` entries in a manifest contribute
   * nothing — the shape a caller that predates MCP still gets.
   */
  mcp?: McpRuntime;
};

/**
 * The run as structured OpenAI chunks. Callers that want SSE use
 * {@link runAgentStream}; callers building a non-streaming `chat.completion`
 * aggregate these directly rather than re-parsing the wire format.
 *
 * Like `runAgentStream`, resolution errors (unknown agent, unknown provider)
 * surface as a `GatewayError` thrown from the first `next()`, not at call time.
 */
export function runAgentChunks(opts: RunnerOpts): AsyncIterable<OpenAIChunk> {
  return { [Symbol.asyncIterator]() { return generate(opts); } };
}

export function runAgentStream(opts: RunnerOpts): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const chunk of runAgentChunks(opts)) {
        yield formatSseChunk(chunk);
      }
      yield DONE_SENTINEL;
    },
  };
}

async function* generate(opts: RunnerOpts): AsyncGenerator<OpenAIChunk> {
  const { config, store, request } = opts;
  let lookup: AgentLookup | null = null;
  if (request.agentId) {
    lookup = store.lookupAgent(request.agentId);
    if (!lookup) {
      const known = store.listApps().flatMap((a) => a.manifest?.agents.map((ag) => ag.id) ?? []);
      throw new GatewayError(
        404,
        "invalid_request_error",
        `unknown agent: ${request.agentId}. Known: ${known.join(", ") || "(none)"}`,
        "unknown_agent",
      );
    }
  }

  const agent: Agent | null = lookup?.agent ?? null;
  const systemPrompt = agent?.system_prompt || GENERIC_SYSTEM_PROMPT;

  const providerName = agent?.provider ?? config.defaultProvider;
  const provider = config.providers[providerName];
  if (!provider) {
    throw new GatewayError(
      500,
      "internal_error",
      `provider "${providerName}" resolved but not present in config.providers`,
      "unknown_provider",
    );
  }

  const model = request.model || agent?.default_model || provider.defaultModel;
  const chatId = `chatcmpl-${ulid()}`;
  const created = Math.floor(Date.now() / 1000);
  const tCtx = createTranslateContext({ id: chatId, created, model, showToolCalls: request.showToolCalls });

  const cwd = await materializeSkills({
    tmpDir: config.tmpDir,
    agentId: agent?.id ?? "_generic",
    skills: agent?.skills ?? [],
  });

  // `api_call` entries are one tool each; each `mcp` entry fans out into
  // whatever its server advertises, so the declared array is not the exposed
  // one. Discovery never throws — an unreachable server contributes no tools
  // and the run proceeds with the rest.
  const { apiCallTools, mcpTools } = opts.mcp
    ? await expandAgentTools(agent?.tools ?? [], opts.mcp)
    : {
        apiCallTools: (agent?.tools ?? []).filter((t) => t.type === "api_call"),
        mcpTools: [] as ResolvedMcpTool[],
      };

  /** Both transports return the same contract, so results are wrapped alike. */
  const asToolResult = (result: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
  });
  const asToolError = (err: unknown) =>
    asToolResult({ error: { message: (err as Error).message } });

  const sdkTools = [
    ...apiCallTools.map((t) =>
      tool(
        t.name,
        t.description,
        jsonSchemaToZodRawShape(t.parameters as Record<string, unknown>),
        async (args: Record<string, unknown>) => {
          if (!lookup) {
            throw new Error("internal: tool handler invoked without app lookup");
          }
          try {
            return asToolResult(
              await invokeTool({
                tool: t as Tool,
                baseUrl: lookup.app.base_url,
                appToken: lookup.app.app_token,
                input: args,
                defaultTimeoutMs: config.toolCallTimeoutMs,
              }),
            );
          } catch (err) {
            return asToolError(err);
          }
        },
      ),
    ),
    ...mcpTools.map((t) =>
      tool(
        t.exposedName,
        t.description,
        jsonSchemaToZodRawShape(t.inputSchema),
        async (args: Record<string, unknown>) => {
          try {
            return asToolResult(
              await invokeTool({
                tool: t.entry,
                toolName: t.toolName,
                input: args,
                defaultTimeoutMs: config.toolCallTimeoutMs,
                mcp: opts.mcp,
              }),
            );
          } catch (err) {
            return asToolError(err);
          }
        },
      ),
    ),
  ];

  const mcpServer =
    sdkTools.length > 0
      ? createSdkMcpServer({ name: "iriguchi-app-tools", version: "1.0.0", tools: sdkTools })
      : undefined;

  for (const c of translateSdkEvent({ type: "stream_start" }, tCtx)) {
    yield c;
  }

  const prompt = buildPrompt(request.messages);
  const sdkOptions: Record<string, unknown> = {
    model,
    systemPrompt,
    cwd,
    maxTurns: config.maxAgentTurns,
    settingSources: ["project"] as const,
    skills: "all" as const,
    env: {
      ...process.env,
      ...providerCredentialEnv(provider),
    },
  };
  if (mcpServer) {
    sdkOptions.mcpServers = { app: mcpServer };
    // App tools are gateway-owned; grant them explicitly or the CLI's
    // permission model denies every mcp__app__* call in headless mode.
    sdkOptions.allowedTools = [
      ...apiCallTools.map((t) => `mcp__app__${t.name}`),
      ...mcpTools.map((t) => `mcp__app__${t.exposedName}`),
    ];
  }

  const sdkStream = query({ prompt, options: sdkOptions as any });
  for await (const evt of adaptSdkStream(sdkStream)) {
    for (const c of translateSdkEvent(evt, tCtx)) {
      yield c;
    }
  }
  for (const c of translateSdkEvent({ type: "done", reason: "stop" }, tCtx)) {
    yield c;
  }
}

function buildPrompt(messages: ChatRequest["messages"]): string {
  return messages
    .filter((m) => m.role !== "system")
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n\n");
}

async function* adaptSdkStream(stream: AsyncIterable<any>): AsyncGenerator<SdkEvent> {
  for await (const msg of stream) {
    if (msg?.type === "assistant" && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text) {
          yield { type: "text_chunk", text: block.text };
        } else if (block.type === "tool_use") {
          yield { type: "tool_use", id: block.id, name: block.name, input: block.input };
        }
      }
    } else if (msg?.type === "user" && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === "tool_result") {
          yield { type: "tool_result", id: block.tool_use_id, result: block.content };
        }
      }
    }
  }
}
