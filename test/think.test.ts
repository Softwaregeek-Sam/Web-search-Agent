import { describe, expect, it } from "vitest";
import { ThinkStripper } from "../src/llm/think.js";

const run = (chunks: string[]) => {
  const s = new ThinkStripper();
  return chunks.map((c) => s.push(c)).join("") + s.end();
};

describe("ThinkStripper", () => {
  it("drops a think block in one chunk", () => {
    expect(run(["a<think>hidden</think>b"])).toBe("ab");
  });
  it("handles tags split across chunks", () => {
    expect(run(["a<thi", "nk>hid", "den</thi", "nk>\n\nb"])).toBe("ab");
  });
  it("keeps a lone angle bracket", () => {
    expect(run(["1 <", " 2"])).toBe("1 < 2");
    expect(run(["x <"])).toBe("x <");
  });
  it("drops an unterminated think block", () => {
    expect(run(["ok<think>never closes"])).toBe("ok");
  });
});
