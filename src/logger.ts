export type Level = "debug" | "info" | "warn" | "error";
export type LogLevel = Level | "silent";
export type Fields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  child(bindings: Fields): Logger;
}

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

export interface LoggerOptions {
  level: LogLevel;
  format?: "pretty" | "json";
  sink?: (line: string, level: Level) => void;
  bindings?: Fields;
}

const defaultSink = (line: string, level: Level) => (level === "error" ? console.error(line) : console.log(line));

function pretty(v: unknown): string {
  if (typeof v === "string") return /^[\w.\-:/,@]{1,60}$/.test(v) ? v : JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean" || v === null) return String(v);
  return JSON.stringify(v);
}

const kv = (f: Fields) =>
  Object.entries(f)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${pretty(v)}`)
    .join(" ");

export function createLogger(opts: LoggerOptions): Logger {
  const { level, format = "pretty", sink = defaultSink, bindings = {} } = opts;
  const emit = (lvl: Level, msg: string, fields: Fields = {}) => {
    if (RANK[lvl] < RANK[level]) return;
    const now = new Date();
    if (format === "json") {
      sink(JSON.stringify({ time: now.toISOString(), level: lvl, msg, ...bindings, ...fields }), lvl);
      return;
    }
    const time = now.toISOString().slice(11, 23);
    const parts = [time, lvl.toUpperCase().padEnd(5), msg, kv(bindings), kv(fields)].filter(Boolean);
    sink(parts.join(" "), lvl);
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (b) => createLogger({ ...opts, bindings: { ...bindings, ...b } }),
  };
}

export const silentLogger: Logger = createLogger({ level: "silent" });

export const clip = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Flatten an error (including OpenAI SDK API errors) into loggable fields. */
export function errFields(err: unknown): Fields {
  if (err instanceof Error) {
    const e = err as Error & { status?: number; code?: string; error?: unknown };
    return {
      err: e.name,
      message: e.message,
      status: e.status,
      code: e.code,
      body: e.error === undefined ? undefined : clip(JSON.stringify(e.error), 500),
    };
  }
  return { message: String(err) };
}
