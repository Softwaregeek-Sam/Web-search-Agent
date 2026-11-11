import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("builds the model list and treats blanks as unset", () => {
    const c = loadConfig({ OPENROUTER_API_KEY: "k", MODEL_ID: "a/b", MODEL_FALLBACKS: "c/d, e/f", FAST_MODEL_ID: "", PORT: "" });
    expect(c.models).toEqual(["a/b", "c/d", "e/f"]);
    expect(c.fastModel).toBeUndefined();
    expect(c.port).toBe(3000);
    expect(c.dbPath).toBe("./data/agent.db");
  });
  it("explains what is missing", () => {
    expect(() => loadConfig({})).toThrow(/OPENROUTER_API_KEY[\s\S]*MODEL_ID/);
  });
});
