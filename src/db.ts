import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CitationSource, Role, SearchQueryRecord, StoredMessage } from "./types.js";

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
      CREATE TABLE IF NOT EXISTS search_queries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        message_id INTEGER NOT NULL REFERENCES messages(id),
        query TEXT NOT NULL,
        recency_after TEXT,
        topic TEXT,
        domains_json TEXT NOT NULL,
        retrieved_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS message_sources (
        message_id INTEGER NOT NULL REFERENCES messages(id),
        source_order INTEGER NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        domain TEXT NOT NULL,
        published_date TEXT,
        snippet TEXT NOT NULL,
        retrieved_at TEXT NOT NULL,
        PRIMARY KEY (message_id, source_order)
      );
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

  addSearchProvenance(
    conversationId: string,
    userId: string,
    messageId: number,
    queries: SearchQueryRecord[],
    sources: CitationSource[],
  ): void {
    const queryInsert = this.db.prepare(
      `INSERT INTO search_queries
       (conversation_id, user_id, message_id, query, recency_after, topic, domains_json, retrieved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const sourceInsert = this.db.prepare(
      `INSERT INTO message_sources
       (message_id, source_order, title, url, domain, published_date, snippet, retrieved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const query of queries) {
      queryInsert.run(
        conversationId,
        userId,
        messageId,
        query.query,
        query.recency_after ?? null,
        query.topic ?? null,
        JSON.stringify(query.domains ?? []),
        query.retrievedAt,
      );
    }
    for (const [index, source] of sources.entries()) {
      sourceInsert.run(
        messageId,
        index + 1,
        source.title,
        source.url,
        source.domain,
        source.published_date,
        source.snippet,
        source.retrieved_at,
      );
    }
  }

  messageSources(messageId: number): CitationSource[] {
    const rows = this.db
      .prepare("SELECT title, url, domain, published_date, snippet, retrieved_at FROM message_sources WHERE message_id = ? ORDER BY source_order")
      .all(messageId) as unknown as CitationSource[];
    return rows;
  }

  searchQueriesForMessage(messageId: number, userId: string): SearchQueryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT query, recency_after, topic, domains_json, retrieved_at
         FROM search_queries WHERE message_id = ? AND user_id = ? ORDER BY id`,
      )
      .all(messageId, userId) as unknown as {
      query: string;
      recency_after: string | null;
      topic: "general" | "news" | null;
      domains_json: string;
      retrieved_at: string;
    }[];
    return rows.map((row) => ({
      query: row.query,
      recency_after: row.recency_after ?? undefined,
      topic: row.topic ?? undefined,
      domains: JSON.parse(row.domains_json) as string[],
      retrievedAt: row.retrieved_at,
    }));
  }

  latestSearchedAnswer(userId: string): { message: StoredMessage; queries: SearchQueryRecord[] } | undefined {
    const row = this.db
      .prepare(
        `SELECT m.* FROM messages m
         JOIN search_queries q ON q.message_id = m.id
         WHERE m.user_id = ? AND m.role = 'assistant'
         ORDER BY m.id DESC LIMIT 1`,
      )
      .get(userId) as unknown as Row | undefined;
    if (!row) return undefined;
    const message = toMessage(row);
    return { message, queries: this.searchQueriesForMessage(message.id, userId) };
  }

  conversationMessagesWithSources(conversationId: string, userId: string) {
    return this.conversationMessages(conversationId, userId).map((message) => ({
      ...message,
      sources: message.role === "assistant" ? this.messageSources(message.id) : [],
    }));
  }

  close() {
    this.db.close();
  }
}
