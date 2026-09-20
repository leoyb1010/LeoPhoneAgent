import fs from 'node:fs';

import { EVENT_USER_MESSAGE, type HarnessEvent } from './harness-dialects.js';

export function lastPromptSeq(events: readonly Pick<HarnessEvent, 'event' | 'mode' | 'seq' | 'text'>[]): {
  seq: number;
  prompt: string;
} {
  let seq = 0;
  let prompt = '';
  for (const ev of events) {
    if (ev.event !== EVENT_USER_MESSAGE) continue;
    if (ev.mode === 'steer' || ev.mode === 'follow_up') continue;
    if (typeof ev.seq !== 'number' || ev.seq <= 0) continue;
    seq = ev.seq;
    prompt = String(ev.text ?? '').trim();
  }
  return { seq, prompt };
}

type PiSessionLine = {
  type?: string;
  message?: { role?: string };
};

export function rewindPiLastUser(file: string): boolean {
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  const lines = raw.split('\n');
  let cut = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i].trim();
    if (!text) continue;
    let row: PiSessionLine;
    try {
      row = JSON.parse(text) as PiSessionLine;
    } catch {
      continue;
    }
    if (row.type === 'message' && row.message?.role === 'user') cut = i;
  }
  if (cut < 0) return false;
  const kept = lines.slice(0, cut);
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  fs.writeFileSync(file, kept.length ? `${kept.join('\n')}\n` : '', { mode: 0o600 });
  return true;
}
