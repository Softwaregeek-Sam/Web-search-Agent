import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { runTurn, type AgentDeps } from "./agent/loop.js";
import { clip, errFields } from "./logger.js";

const chatBody = z.object({
  conversationId: z.string().uuid().optional(),
  message: z.string().trim().min(1).max(8000),
  tz: z.string().max(64).optional(),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(8000),
        ts: z.union([z.number(), z.string()]).optional(),
      }),
    )
    .max(200)
    .optional(),
});

/**
 * Serve the browser (ESM) builds of marked and DOMPurify straight from node_modules, no build step.
 * Both are self-contained ESM files at each package's public entry point, so we resolve the package
 * name (their exports maps do not expose deep paths).
 */
function vendorRoute(app: Hono, route: string, pkg: string) {
  app.get(route, async (c) => {
    const file = await readFile(fileURLToPath(import.meta.resolve(pkg)), "utf8");
    return c.body(file, 200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=86400" });
  });
}

export function createApp(deps: AgentDeps) {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  app.onError((err, c) => {
    deps.log.error("http.unhandled", { method: c.req.method, path: c.req.path, ...errFields(err) });
    return c.json({ error: "Internal error" }, 500);
  });

  app.post("/api/chat", async (c) => {
    const reqId = randomUUID().slice(0, 8);
    const t0 = Date.now();
    let userId = getCookie(c, "uid");
    const newUser = !userId;
    if (!userId) {
      userId = randomUUID();
      setCookie(c, "uid", userId, { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
    }
    const log = deps.log.child({ req: reqId, user: userId.slice(0, 8) });

    const raw = await c.req.json().catch(() => null);
    const parsed = chatBody.safeParse(raw);
    if (!parsed.success) {
      log.warn("http.bad_request", { issues: clip(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), 300) });
      return c.json({ error: "Invalid request", issues: parsed.error.issues }, 400);
    }
    log.info("http.request", { method: "POST", path: "/api/chat", newUser });
    const uid = userId;

    return streamSSE(c, async (stream) => {
      const abort = new AbortController();
      let aborted = false;
      let events = 0;
      let outcome = "ok";
      stream.onAbort(() => {
        aborted = true;
        log.warn("http.client_disconnected", { afterMs: Date.now() - t0 });
        abort.abort();
      });
      try {
        for await (const ev of runTurn({ ...deps, log }, { ...parsed.data, userId: uid, signal: abort.signal })) {
          events++;
          if (ev.type === "error") outcome = "error";
          await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) });
        }
      } catch (err) {
        outcome = "crash";
        log.error("http.stream_crash", errFields(err));
        await stream.writeSSE({ event: "error", data: JSON.stringify({ type: "error", message: "Internal error while answering." }) });
      } finally {
        log.info("http.response.end", { status: 200, outcome: aborted ? "aborted" : outcome, events, ms: Date.now() - t0 });
      }
    });
  });

  app.get("/api/conversations/:id", (c) => {
    const userId = getCookie(c, "uid");
    if (!userId) return c.json({ messages: [] });
    return c.json({ messages: deps.store.conversationMessagesWithSources(c.req.param("id"), userId) });
  });

  vendorRoute(app, "/vendor/marked.js", "marked");
  vendorRoute(app, "/vendor/purify.js", "dompurify");
  app.use("/*", serveStatic({ root: "./public" }));

  return app;
}
