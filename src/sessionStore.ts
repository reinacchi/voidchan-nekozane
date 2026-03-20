import crypto from "node:crypto";
import type { SessionRecord } from "./types.js";

const sessions = new Map<string, SessionRecord>();

export function getOrCreateSession(sessionId?: string) {
  const id = sessionId && sessions.has(sessionId) ? sessionId : crypto.randomUUID();
  const record = sessions.get(id) ?? {};
  sessions.set(id, record);
  return { id, record };
}

export function saveSession(id: string, record: SessionRecord) {
  sessions.set(id, record);
}

export function randomState() {
  return crypto.randomBytes(24).toString("hex");
}
