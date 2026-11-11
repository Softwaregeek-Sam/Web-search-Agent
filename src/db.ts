import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Role, StoredMessage } from "./types.js";

interface Row {
  id: number;
  conversation_id: string;
  user_id: string;
  role: Role;
  content: string;
  created_at: number;
  tz: string;
}

const toMessage = (r: Row): StoredMessage => ({
  id: r.id,
  conversationId: r.conversation_id,
  userId: r.user_id,
  role: r.role,
  content: r.content,
  createdAt: r.created_at,
  tz: r.tz,
});

const STOPWORDS = new Set(
  "the and for with that this what when where which who how did you your are was were have has had can could would should about from into over after before then than them they there their will just also our we us me my i it its is be been to of in on at by an a or as if so do does not no yes any all some more most than very".split(
    " ",
  ),
);

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        user_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user','assistant')),
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        tz TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_user_time ON messages(user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content, content='messages', content_rowid='id'
      );
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `);
  }

  /** Returns false when the conversation belongs to another user. */
  ensureConversation(id: string, userId: string, now: number): boolean {
    const row = this.db.prepare("SELECT user_id FROM conversations WHERE id = ?").get(id) as unknown as { user_id: string } | undefined;
    if (row) return row.user_id === userId;
    this.db.prepare("INSERT INTO conversations (id, user_id, created_at) VALUES (?, ?, ?)").run(id, userId, now);
    return true;
  }

  addMessage(m: Omit<StoredMessage, "id">): number {
    const info = this.db
      .prepare(
        "INSERT INTO messages (conversation_id, user_id, role, content, created_at, tz) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(m.conversationId, m.userId, m.role, m.content, m.createdAt, m.tz);
    return Number(info.lastInsertRowid);
  }

  conversationMessages(conversationId: string, userId: string): StoredMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE conversation_id = ? AND user_id = ? ORDER BY id ASC")
      .all(conversationId, userId) as unknown as Row[];
    return rows.map(toMessage);
  }

  /** Messages in [startMs, endMs) across the user's other conversations. */
  messagesInRange(userId: string, startMs: number, endMs: number, excludeConversationId: string, limit: number) {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE user_id = ? AND created_at >= ? AND created_at < ? AND conversation_id != ?
         ORDER BY created_at ASC, id ASC LIMIT ?`,
      )
      .all(userId, startMs, endMs, excludeConversationId, limit) as unknown as Row[];
    return rows.map(toMessage);
  }

  /** BM25-ranked keyword search over the user's other conversations. */
  searchMessages(userId: string, text: string, excludeConversationId: string, limit: number): StoredMessage[] {
    const tokens = [
      ...new Set(
        (text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((t) => !STOPWORDS.has(t)),
      ),
    ].slice(0, 8);
    if (tokens.length === 0) return [];
    const q = tokens.map((t) => `"${t}"`).join(" OR ");
    const rows = this.db
      .prepare(
        `SELECT m.* FROM messages_fts f JOIN messages m ON m.id = f.rowid
         WHERE messages_fts MATCH ? AND m.user_id = ? AND m.conversation_id != ?
         ORDER BY bm25(messages_fts) LIMIT ?`,
      )
      .all(q, userId, excludeConversationId, limit) as unknown as Row[];
    return rows.map(toMessage);
  }

  /** The message next to this one in its conversation (the reply for a user message, else the prompt). */
  neighbor(m: StoredMessage): StoredMessage | undefined {
    const row = (
      m.role === "user"
        ? this.db
            .prepare("SELECT * FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id ASC LIMIT 1")
            .get(m.conversationId, m.id)
        : this.db
            .prepare("SELECT * FROM messages WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT 1")
            .get(m.conversationId, m.id)
    ) as unknown as Row | undefined;
    return row ? toMessage(row) : undefined;
  }

  close() {
    this.db.close();
  }
}
