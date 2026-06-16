import { ulid } from "ulid";
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../config.ts";
import type { Store, AgentLookup } from "../registry/store.ts";
import type { Tool, Agent } from "../registry/schema.ts";
import { materializeSkills } from "./skills.ts";
import { invokeApiCallTool } from "./tools.ts";
import { jsonSchemaToZodRawShape } from "./json-schema-to-zod.ts";
import {
  translateSdkEvent,
  formatSseChunk,
  createTranslateContext,
  DONE_SENTINEL,
  type SdkEvent,
} from "./openai-sse.ts";

const GENERIC_SYSTEM_PROMPT = "You are a helpful general-purpose assistant.";

export class GatewayError extends Error {
  constructor(
    public httpStatus: number,
    public type: string,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

export type ChatRequest = {
  requestId: string;
  agentId: string | null;
  model: string | null;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  showToolCalls: boolean;
};

export type RunnerOpts = {
  config: Pick<
    Config,
    "defaultModel" | "tmpDir" | "maxAgentTurns" | "toolCallTimeoutMs" | "anthropicApiKey" | "anthropicBaseUrl"
  >;
  store: Store;
  request: ChatRequest;
};

export function runAgentStream(opts: RunnerOpts): AsyncIterable<string> {
  return { [Symbol.asyncIterator]() { return generate(opts); } };
}

async function* generate(opts: RunnerOpts): AsyncGenerator<string> {
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
  const model = request.model || agent?.default_model || config.defaultModel;
  const chatId = `chatcmpl-${ulid()}`;
  const created = Math.floor(Date.now() / 1000);
  const tCtx = createTranslateContext({ id: chatId, created, model, showToolCalls: request.showToolCalls });

  const cwd = await materializeSkills({
    tmpDir: config.tmpDir,
    agentId: agent?.id ?? "_generic",
    skills: agent?.skills ?? [],
  });

  const mcpTools = (agent?.tools ?? []).map((t) => {
    const paramShape = jsonSchemaToZodRawShape(
      t.parameters as Record<string, unknown>,
    );
    return tool(
      t.name,
      t.description,
      paramShape,
      async (args: Record<string, unknown>) => {
        if (!lookup) {
          throw new Error("internal: tool handler invoked without app lookup");
        }
        try {
          const result = await invokeApiCallTool({
            tool: t as Tool,
            baseUrl: lookup.app.base_url,
            appToken: lookup.app.app_token,
            input: args,
            defaultTimeoutMs: config.toolCallTimeoutMs,
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: (err as Error).message }),
              },
            ],
          };
        }
      },
    );
  });

  const mcpServer =
    mcpTools.length > 0
      ? createSdkMcpServer({ name: "iriguchi-app-tools", version: "1.0.0", tools: mcpTools })
      : undefined;

  const prevKey = process.env.ANTHROPIC_API_KEY;
  const prevBase = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_API_KEY = config.anthropicApiKey;
  if (config.anthropicBaseUrl) process.env.ANTHROPIC_BASE_URL = config.anthropicBaseUrl;

  try {
    for (const c of translateSdkEvent({ type: "stream_start" }, tCtx)) {
      yield formatSseChunk(c);
    }

    const prompt = buildPrompt(request.messages);
    const sdkOptions: Record<string, unknown> = {
      model,
      systemPrompt,
      cwd,
      maxTurns: config.maxAgentTurns,
      settingSources: ["project"] as const,
      skills: "all" as const,
    };
    if (mcpServer) sdkOptions.mcpServers = { app: mcpServer };

    const sdkStream = query({ prompt, options: sdkOptions as any });
    for await (const evt of adaptSdkStream(sdkStream)) {
      for (const c of translateSdkEvent(evt, tCtx)) {
        yield formatSseChunk(c);
      }
    }
    for (const c of translateSdkEvent({ type: "done", reason: "stop" }, tCtx)) {
      yield formatSseChunk(c);
    }
    yield DONE_SENTINEL;
  } finally {
    if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
    else delete process.env.ANTHROPIC_API_KEY;
    if (prevBase !== undefined) process.env.ANTHROPIC_BASE_URL = prevBase;
    else delete process.env.ANTHROPIC_BASE_URL;
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
