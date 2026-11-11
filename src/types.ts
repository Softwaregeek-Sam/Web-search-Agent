export type Role = "user" | "assistant";

export interface StoredMessage {
  id: number;
  conversationId: string;
  userId: string;
  role: Role;
  content: string;
  createdAt: number; // epoch ms, UTC
  tz: string;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface LlmAssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: LlmToolCall[];
}

export interface LlmToolMessage {
  role: "tool";
  content: string;
  tool_call_id: string;
}

export type LlmConversationMessage = LlmMessage | LlmAssistantMessage | LlmToolMessage;

export interface LlmToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface TurnTrace {
  model: string;
  ttftMs: number | null;
  searchMs: number | null;
  totalMs: number;
  recalledMessages: number;
  promptChars: number;
}

export type AgentEvent =
  | { type: "meta"; conversationId: string }
  | { type: "status"; text: string }
  | { type: "token"; text: string }
  | { type: "done"; messageId: number; trace: TurnTrace }
  | { type: "error"; message: string };
