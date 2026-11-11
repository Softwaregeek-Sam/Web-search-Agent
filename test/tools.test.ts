import { describe, expect, it } from "vitest";
import { toolRepairMessage, validateWebSearchToolCall, ToolArgumentError, WEB_SEARCH_TOOL } from "../src/agent/tools.js";

const call = (argumentsText: string) => ({
  id: "call-1",
  type: "function" as const,
  function: { name: "web_search", arguments: argumentsText },
});

describe("web_search tool validation", () => {
  it("defines the tool schema and accepts valid arguments", () => {
    expect(WEB_SEARCH_TOOL.function.name).toBe("web_search");
    expect(validateWebSearchToolCall(call(JSON.stringify({ query: "latest Node.js release", topic: "news" })))).toEqual({
      query: "latest Node.js release",
      topic: "news",
    });
  });

  it("rejects malformed JSON and returns one useful repair message", () => {
    let error: ToolArgumentError | undefined;
    try {
      validateWebSearchToolCall(call("{"));
    } catch (caught) {
      error = caught as ToolArgumentError;
    }

    expect(error).toBeInstanceOf(ToolArgumentError);
    expect(toolRepairMessage(error!)).toEqual({
      role: "tool",
      tool_call_id: "call-1",
      content: expect.stringContaining("Correct the arguments and call web_search again."),
    });
  });

  it("rejects invalid filters and unknown arguments", () => {
    expect(() => validateWebSearchToolCall(call(JSON.stringify({ query: " ", topic: "invalid" })))).toThrow(ToolArgumentError);
    expect(() => validateWebSearchToolCall(call(JSON.stringify({ query: "test", unsupported: true })))).toThrow(ToolArgumentError);
  });
});
