import { z } from "zod";
import type { SearchRequest } from "../search/provider.js";
import type { LlmToolCall, LlmToolDefinition, LlmToolMessage } from "../types.js";

const webSearchArgumentsSchema = z
  .object({
    query: z.string().trim().min(1).max(2000),
    recency_after: z.iso.date().optional(),
    topic: z.enum(["general", "news"]).optional(),
    domains: z.array(z.string().trim().min(1)).max(20).optional(),
  })
  .strict();

export const WEB_SEARCH_TOOL: LlmToolDefinition = {
  type: "function",
  function: {
    name: "web_search",
    description: "Search the web for current information and source-backed results.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "The focused search query.", minLength: 1, maxLength: 2000 },
        recency_after: { type: "string", description: "Only results published on or after this UTC date.", format: "date" },
        topic: { type: "string", enum: ["general", "news"] },
        domains: { type: "array", items: { type: "string" }, maxItems: 20 },
      },
      required: ["query"],
    },
  },
};

export class ToolArgumentError extends Error {
  readonly toolCallId: string;

  constructor(toolCallId: string, message: string) {
    super(message);
    this.name = "ToolArgumentError";
    this.toolCallId = toolCallId;
  }
}

export function validateWebSearchToolCall(call: LlmToolCall): SearchRequest {
  if (call.type !== "function" || call.function.name !== WEB_SEARCH_TOOL.function.name) {
    throw new ToolArgumentError(call.id, `Unsupported tool call "${call.function.name}". Use web_search.`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(call.function.arguments);
  } catch {
    throw new ToolArgumentError(call.id, "web_search arguments must be valid JSON with a non-empty query.");
  }
  const parsed = webSearchArgumentsSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 1)
      .map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`)
      .join("; ");
    throw new ToolArgumentError(call.id, `Invalid web_search arguments (${detail}). Provide a non-empty query and valid optional filters.`);
  }
  return parsed.data;
}

export function toolRepairMessage(error: ToolArgumentError): LlmToolMessage {
  return {
    role: "tool",
    tool_call_id: error.toolCallId,
    content: `Tool call rejected: ${error.message} Correct the arguments and call web_search again.`,
  };
}
