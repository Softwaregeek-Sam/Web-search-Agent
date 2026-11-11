import { z } from "zod";

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const opt = <T extends z.ZodType>(s: T) => z.preprocess(blankToUndefined, s.optional());

const schema = z.object({
  OPENROUTER_API_KEY: z.string({ error: "missing: set your OpenRouter key" }).min(1, "missing: set your OpenRouter key"),
  MODEL_ID: z.string({ error: "missing: pick an open-weight model slug from openrouter.ai/models" }).min(1, "missing: pick an open-weight model slug from openrouter.ai/models"),
  MODEL_FALLBACKS: opt(z.string()),
  FAST_MODEL_ID: opt(z.string()),
  OPENROUTER_BASE_URL: opt(z.string().url()),
  PROVIDER_ORDER: opt(z.string()),
  REASONING_EFFORT: opt(z.enum(["low", "medium", "high"])),
  TAVILY_API_KEY: opt(z.string()),
  LOG_LEVEL: opt(z.enum(["debug", "info", "warn", "error", "silent"])),
  LOG_FORMAT: opt(z.enum(["pretty", "json"])),
  PORT: z.preprocess(blankToUndefined, z.coerce.number().int().positive().default(3000)),
  DB_PATH: z.preprocess(blankToUndefined, z.string().default("./data/agent.db")),
});

export interface Config {
  openrouterKey: string;
  models: string[];
  fastModel?: string;
  baseUrl?: string;
  providerOrder?: string[];
  reasoningEffort?: "low" | "medium" | "high";
  tavilyKey?: string;
  logLevel: "debug" | "info" | "warn" | "error" | "silent";
  logFormat: "pretty" | "json";
  port: number;
  dbPath: string;
}

const list = (s?: string) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : []);

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration (see .env.example):\n${lines.join("\n")}`);
  }
  const e = parsed.data;
  const order = list(e.PROVIDER_ORDER);
  return {
    openrouterKey: e.OPENROUTER_API_KEY,
    models: [e.MODEL_ID, ...list(e.MODEL_FALLBACKS)],
    fastModel: e.FAST_MODEL_ID,
    baseUrl: e.OPENROUTER_BASE_URL,
    providerOrder: order.length ? order : undefined,
    reasoningEffort: e.REASONING_EFFORT,
    tavilyKey: e.TAVILY_API_KEY,
    logLevel: e.LOG_LEVEL ?? "info",
    logFormat: e.LOG_FORMAT ?? "pretty",
    port: e.PORT,
    dbPath: e.DB_PATH,
  };
}
