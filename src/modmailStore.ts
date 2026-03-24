import fs from "node:fs";
import path from "node:path";
import sqlite3 from "sqlite3";

export interface ThreadRecord {
  id: number;
  userId: string;
  channelId: string;
  status: "open" | "closed";
  createdAt: string;
  closedAt: string | null;
}

const dataDir = path.resolve(process.cwd(), "data");
fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, "modmail.sqlite");
const sqlite = sqlite3.verbose();
const db = new sqlite.Database(dbPath);

function run(sql: string, params: unknown[] = []): Promise<{ lastID: number; changes: number }> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) {
        reject(error);
        return;
      }

      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(row as T | undefined);
    });
  });
}

function normalizeThread(row: {
  id: number;
  user_id: string;
  channel_id: string;
  status: "open" | "closed";
  created_at: string;
  closed_at: string | null;
}): ThreadRecord {
  return {
    id: row.id,
    userId: row.user_id,
    channelId: row.channel_id,
    status: row.status,
    createdAt: row.created_at,
    closedAt: row.closed_at
  };
}

export async function initializeModmailStore(): Promise<void> {
  await run(`
    CREATE TABLE IF NOT EXISTS counters (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS threads (
      id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      channel_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('open', 'closed')),
      created_at TEXT NOT NULL,
      closed_at TEXT
    )
  `);

  await run(`INSERT OR IGNORE INTO counters(key, value) VALUES ('thread_count', 0)`);
}

export async function nextThreadId(): Promise<number> {
  await run("UPDATE counters SET value = value + 1 WHERE key = 'thread_count'");
  const counter = await get<{ value: number }>("SELECT value FROM counters WHERE key = 'thread_count'");
  if (!counter) throw new Error("Failed to read thread counter.");
  return counter.value;
}

export async function saveOpenThread(userId: string, channelId: string, threadId: number): Promise<ThreadRecord> {
  const now = new Date().toISOString();
  await run(
    `INSERT INTO threads(id, user_id, channel_id, status, created_at, closed_at)
     VALUES (?, ?, ?, 'open', ?, NULL)
     ON CONFLICT(user_id) DO UPDATE SET
       id = excluded.id,
       channel_id = excluded.channel_id,
       status = 'open',
       created_at = excluded.created_at,
       closed_at = NULL`,
    [threadId, userId, channelId, now]
  );

  return {
    id: threadId,
    userId,
    channelId,
    status: "open",
    createdAt: now,
    closedAt: null
  };
}

export async function getOpenThreadByUserId(userId: string): Promise<ThreadRecord | null> {
  const row = await get<{
    id: number;
    user_id: string;
    channel_id: string;
    status: "open" | "closed";
    created_at: string;
    closed_at: string | null;
  }>("SELECT * FROM threads WHERE user_id = ? AND status = 'open'", [userId]);

  return row ? normalizeThread(row) : null;
}

export async function getOpenThreadByChannelId(channelId: string): Promise<ThreadRecord | null> {
  const row = await get<{
    id: number;
    user_id: string;
    channel_id: string;
    status: "open" | "closed";
    created_at: string;
    closed_at: string | null;
  }>("SELECT * FROM threads WHERE channel_id = ? AND status = 'open'", [channelId]);

  return row ? normalizeThread(row) : null;
}

export async function closeThreadByChannelId(channelId: string): Promise<void> {
  await run(
    "UPDATE threads SET status = 'closed', closed_at = ? WHERE channel_id = ? AND status = 'open'",
    [new Date().toISOString(), channelId]
  );
}
