import { marked } from "/vendor/marked.js";
import DOMPurify from "/vendor/purify.js";

const log = document.getElementById("log");
const empty = document.getElementById("empty");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const send = document.getElementById("send");
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

let conversationId = localStorage.getItem("conversationId") || undefined;
let controller = null;

const stampFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const stamp = (ms) => stampFmt.format(new Date(ms));
const render = (md) => DOMPurify.sanitize(marked.parse(md, { gfm: true, breaks: false }), { ADD_ATTR: ["target"] });

function addSources(body, sources = []) {
  if (!sources.length) return;
  const list = document.createElement("div");
  list.className = "sources";
  const heading = document.createElement("strong");
  heading.textContent = "Sources";
  list.append(heading);
  sources.forEach((source, index) => {
    const link = document.createElement("a");
    link.href = source.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = `[${index + 1}] ${source.title} (${source.domain})`;
    list.append(link);
  });
  body.append(list);
}

function addMessage(role, text, ms = Date.now(), sources = []) {
  empty?.remove();
  const row = document.createElement("article");
  row.className = `msg ${role}`;
  row.innerHTML = `<div class="stamp"></div><div class="body"></div>`;
  row.querySelector(".stamp").textContent = stamp(ms);
  const body = row.querySelector(".body");
  if (role === "user") body.textContent = text;
  else body.innerHTML = render(text);
  if (role !== "user") addSources(body, sources);
  log.append(row);
  log.scrollTop = log.scrollHeight;
  return body;
}

function setBusy(busy) {
  send.textContent = busy ? "Stop" : "Send";
  send.classList.toggle("stop", busy);
  send.type = busy ? "button" : "submit";
}

async function* readSSE(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (data) yield JSON.parse(data);
    }
  }
}

async function ask(message) {
  addMessage("user", message);
  const body = addMessage("assistant", "");
  const status = document.createElement("div");
  status.className = "status";
  status.textContent = "Thinking";
  body.append(status);

  controller = new AbortController();
  setBusy(true);
  let text = "";
  let sources = [];
  let errorMessage = "";
  let pending = false;
  const paint = () => {
    pending = false;
    body.innerHTML = render(text);
    log.scrollTop = log.scrollHeight;
  };

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, conversationId, tz }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    for await (const ev of readSSE(res)) {
      if (ev.type === "meta") {
        conversationId = ev.conversationId;
        localStorage.setItem("conversationId", conversationId);
      } else if (ev.type === "status") {
        status.textContent = ev.text;
      } else if (ev.type === "token") {
        text += ev.text;
        if (!pending) { pending = true; requestAnimationFrame(paint); }
      } else if (ev.type === "error") {
        errorMessage = ev.message;
      } else if (ev.type === "done") {
        sources = ev.sources || [];
      }
    }
    paint();
    if (errorMessage) {
      const err = document.createElement("div");
      err.className = "status error";
      err.textContent = errorMessage;
      body.append(err);
    }
    addSources(body, sources);
  } catch (err) {
    if (err.name !== "AbortError") {
      const e = document.createElement("div");
      e.className = "status error";
      e.textContent = err.message;
      body.append(e);
    } else paint();
  } finally {
    controller = null;
    setBusy(false);
    input.focus();
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const message = input.value.trim();
  if (!message || controller) return;
  input.value = "";
  input.style.height = "auto";
  ask(message);
});
send.addEventListener("click", () => controller?.abort());
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
});
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
});
document.getElementById("new").addEventListener("click", () => {
  controller?.abort();
  localStorage.removeItem("conversationId");
  conversationId = undefined;
  location.reload();
});
document.querySelectorAll(".examples button").forEach((b) =>
  b.addEventListener("click", () => { input.value = b.textContent; form.requestSubmit(); }),
);

if (conversationId) {
  fetch(`/api/conversations/${conversationId}`)
    .then((r) => r.json())
    .then(({ messages }) => messages.forEach((m) => addMessage(m.role, m.content, m.createdAt, m.sources)))
    .catch(() => {});
}
