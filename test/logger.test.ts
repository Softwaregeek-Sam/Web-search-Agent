import { describe, expect, it } from "vitest";
import { createLogger, errFields } from "../src/logger.js";

const make = (opts: Parameters<typeof createLogger>[0]) => {
  const lines: string[] = [];
  return { lines, log: createLogger({ ...opts, sink: (l) => lines.push(l) }) };
};

describe("logger", () => {
  it("filters by level", () => {
    const { lines, log } = make({ level: "warn" });
    log.debug("d"); log.info("i"); log.warn("w"); log.error("e");
    expect(lines).toHaveLength(2);
  });

  it("silent logs nothing", () => {
    const { lines, log } = make({ level: "silent" });
    log.error("boom");
    expect(lines).toEqual([]);
  });

  it("renders key=value pairs and quotes values with spaces", () => {
    const { lines, log } = make({ level: "info" });
    log.info("turn.start", { chars: 5, tz: "Asia/Kolkata", message: "what's the model name", skip: undefined });
    expect(lines[0]).toMatch(/^\d\d:\d\d:\d\d\.\d{3} INFO  turn\.start /);
    expect(lines[0]).toContain('chars=5 tz=Asia/Kolkata message="what\'s the model name"');
    expect(lines[0]).not.toContain("skip");
  });

  it("child loggers carry bindings and do not mutate the parent", () => {
    const { lines, log } = make({ level: "info" });
    log.child({ req: "abc12345" }).info("x");
    log.info("y");
    expect(lines[0]).toContain("req=abc12345");
    expect(lines[1]).not.toContain("req=");
  });

  it("emits parseable JSON in json mode", () => {
    const { lines, log } = make({ level: "info", format: "json" });
    log.child({ req: "r1" }).info("http.request", { path: "/api/chat" });
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: "info", msg: "http.request", req: "r1", path: "/api/chat" });
  });

  it("flattens API-style errors", () => {
    const e = Object.assign(new Error("401 No auth"), { status: 401, error: { message: "bad key" } });
    expect(errFields(e)).toMatchObject({ message: "401 No auth", status: 401, body: '{"message":"bad key"}' });
    expect(errFields("plain")).toEqual({ message: "plain" });
  });
});
