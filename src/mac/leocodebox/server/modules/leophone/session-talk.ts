import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import { getHarnessManager } from './harness-session.service.js';

export const TALK_QUERY_MIN = 2;
export const TALK_HIT_MAX = 40;

const TALK_EVENTS = new Set(['user.message', 'message.delta', 'message', 'assistant']);

export type SessionTalkHit = { session_id: string; text: string };

export function clipTalkSnippet(text: string, limit = 120): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one.length <= limit) return one;
  return `${one.slice(0, limit)}…`;
}

export function talkEventText(row: Record<string, unknown>): string | null {
  const event = String(row.event ?? '');
  if (!TALK_EVENTS.has(event)) return null;
  const text = String(row.text ?? row.delta ?? row.output ?? '').replace(/\s+/g, ' ').trim();
  return text || null;
}

export function talkLineMatches(line: string, query: string): string | null {
  const q = query.trim().toLowerCase();
  if (q.length < TALK_QUERY_MIN) return null;
  let row: Record<string, unknown>;
  try { row = JSON.parse(line) as Record<string, unknown>; } catch { return null; }
  const text = talkEventText(row);
  if (!text || !text.toLowerCase().includes(q)) return null;
  return clipTalkSnippet(text);
}

export async function searchTalkLog(logPath: string, query: string): Promise<string | null> {
  const stream = createReadStream(logPath, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const hit = talkLineMatches(line, query);
      if (hit) return hit;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return null;
}

export async function searchTalkLogs(logs: ReadonlyArray<{ sessionId: string; logPath: string }>, query: string): Promise<SessionTalkHit[]> {
  const q = query.trim();
  if (q.length < TALK_QUERY_MIN) throw new Error('再写两个字');
  const hits: SessionTalkHit[] = [];
  for (const log of logs) {
    if (hits.length >= TALK_HIT_MAX) break;
    const text = await searchTalkLog(log.logPath, q).catch(() => null);
    if (text) hits.push({ session_id: log.sessionId, text });
  }
  return hits;
}

export async function searchLocalTalk(query: string): Promise<{ query: string; hits: SessionTalkHit[]; truncated: boolean }> {
  const manager = getHarnessManager();
  await manager.ready();
  const hits = await searchTalkLogs(manager.talkLogs(), query);
  return { query: query.trim(), hits, truncated: hits.length >= TALK_HIT_MAX };
}
