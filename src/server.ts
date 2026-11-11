import "dotenv/config";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { Store } from "./db.js";
import { createLogger } from "./logger.js";
import { createOpenRouterClient } from "./llm/client.js";
import { createCachedSearchProvider } from "./search/cache.js";
import { createResilientSearchProvider } from "./search/resilient.js";
import { createTavilyProvider } from "./search/tavily.js";

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const log = createLogger({ level: config.logLevel, format: config.logFormat });
const store = new Store(config.dbPath);
const llm = createOpenRouterClient(config);
const search = config.tavilyKey
  ? createResilientSearchProvider(
      createCachedSearchProvider(createTavilyProvider({ apiKey: config.tavilyKey })),
      { logger: log },
    )
  : undefined;
const app = createApp({ store, llm, search, clock: Date.now, log });

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  log.info("server.start", {
    url: `http://localhost:${info.port}`,
    models: config.models.join(","),
    providers: config.providerOrder?.join(",") ?? "default",
    reasoningEffort: config.reasoningEffort ?? "default",
    db: config.dbPath,
    logLevel: config.logLevel,
  });
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    log.error("server.port_in_use", { port: config.port, hint: "another process is listening there; stop it or set PORT in .env" });
  } else {
    log.error("server.error", { message: err.message, code: err.code });
  }
  process.exit(1);
});

process.on("unhandledRejection", (err) => log.error("process.unhandled_rejection", { message: String(err) }));

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    store.close();
    process.exit(0);
  });
}
