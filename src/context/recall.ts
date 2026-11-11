import type { Store } from "../db.js";
import type { StoredMessage } from "../types.js";
import { describeRefs, formatInstant, resolveTemporalRefs, type TemporalRef } from "./time.js";

const BACKWARD_RE =
  /\b(i (asked|told|said|mentioned|shared)|you (said|told|answered|recommended|suggested|gave)|we (discussed|shortlisted|talked|picked|decided|chose|looked)|earlier|last time|previously|a while ago|remember when|our (last|previous) (chat|conversation))\b/i;

const MAX_WINDOW_MESSAGES = 30;
const MAX_FTS_HITS = 5;
const MAX_MESSAGE_CHARS = 700;
const MAX_BLOCK_CHARS = 6000;

export interface Recall {
  /** Text to inject into the system prompt, or null when nothing was looked up. */
  block: string | null;
  /** One line per resolved date phrase. */
  dateNotes: string | null;
  refs: TemporalRef[];
  messageCount: number;
}

export interface RecallInput {
  userId: string;
  conversationId: string;
  text: string;
  nowMs: number;
  tz: string;
}

const clip = (s: string) => (s.length > MAX_MESSAGE_CHARS ? `${s.slice(0, MAX_MESSAGE_CHARS)}…` : s);

/**
 * Deterministic memory lookup (no LLM): date windows for resolved phrases, plus
 * keyword search when the message points backward. Messages from the current
 * conversation are excluded because the full thread is already in the prompt.
 */
export function buildRecall(store: Store, input: RecallInput): Recall {
  const { userId, conversationId, text, nowMs, tz } = input;
  const refs = resolveTemporalRefs(text, nowMs, tz);
  const backward = BACKWARD_RE.test(text);
  if (refs.length === 0 && !backward) return { block: null, dateNotes: null, refs, messageCount: 0 };

  const byId = new Map<number, StoredMessage>();
  for (const ref of refs.slice(0, 3)) {
    for (const range of ref.ranges.slice(0, 2)) {
      for (const m of store.messagesInRange(userId, range.startMs, range.endMs, conversationId, MAX_WINDOW_MESSAGES)) {
        byId.set(m.id, m);
      }
    }
  }
  const windowHits = byId.size;

  if (backward || windowHits === 0) {
    for (const hit of store.searchMessages(userId, text, conversationId, MAX_FTS_HITS)) {
      byId.set(hit.id, hit);
      const n = store.neighbor(hit);
      if (n) byId.set(n.id, n);
    }
  }

  const ordered = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  const lines: string[] = [];
  let used = 0;
  for (const m of ordered) {
    const line = `[${formatInstant(m.createdAt, tz)}] ${m.role}: ${clip(m.content)}`;
    if (used + line.length > MAX_BLOCK_CHARS) break;
    lines.push(line);
    used += line.length;
  }

  let block: string;
  if (lines.length > 0) {
    block = `<past_conversations>\n${lines.join("\n")}\n</past_conversations>`;
  } else {
    const where = refs.length ? "for those dates or matching those topics" : "matching that topic";
    block = `<past_conversations>\nNo stored messages ${where}.\n</past_conversations>`;
  }
  return { block, dateNotes: describeRefs(refs), refs, messageCount: lines.length };
}
