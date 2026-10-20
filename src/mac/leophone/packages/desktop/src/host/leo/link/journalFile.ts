// HarnessJournal 的文件层:有界的逐行解码、尾部读取、按上限滚动。从 journal.ts 拆出(400 行上限)。
import fs, { promises as fsp } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { setImmediate as yieldImmediate } from 'node:timers/promises';

import type { HarnessEvent } from './journal.js';

export const MAX_RECORD_BYTES = 4 * 1024 * 1024;
/** 单个会话的日志超过这么大,下次建索引时滚动成只留最近 JOURNAL_KEEP_BYTES。 */
export const JOURNAL_ROLL_BYTES = 16 * 1024 * 1024;
const JOURNAL_KEEP_BYTES = 8 * 1024 * 1024;

/** Bounded line decoding: an oversized or incomplete row is never parsed as an event. */
export async function* journalLines(logPath: string, start: number, end: number, signal?: AbortSignal): AsyncGenerator<{
  line: Buffer | null; start: number; end: number; bytesRead: number;
}> {
  if (signal?.aborted) throw signal.reason ?? new Error('Aborted');
  if (end <= start) return;
  const stream = fs.createReadStream(logPath, { start, end: end - 1, highWaterMark: 64 * 1024, signal });
  let remainder = Buffer.alloc(0);
  let offset = start;
  let oversized = false;
  let discarded = 0;
  let bytesRead = 0;
  let rows = 0;
  try {
    for await (const chunk of stream) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytesRead += data.length;
      remainder = Buffer.concat([remainder, data]);
      for (;;) {
        const newline = remainder.indexOf(10);
        if (newline < 0) break;
        const length = discarded + newline + 1;
        yield { line: oversized || newline > MAX_RECORD_BYTES ? null : remainder.subarray(0, newline), start: offset, end: offset + length, bytesRead };
        offset += length;
        remainder = remainder.subarray(newline + 1);
        oversized = false;
        discarded = 0;
        if (++rows % 128 === 0) await yieldImmediate();
      }
      if (remainder.length > MAX_RECORD_BYTES) {
        discarded += remainder.length;
        remainder = Buffer.alloc(0);
        oversized = true;
      }
    }
    if (remainder.length || discarded) {
      yield { line: oversized ? null : remainder, start: offset, end, bytesRead };
    }
  } finally { stream.destroy(); }
}

export function eventFromLine(line: Buffer | null): HarnessEvent | null | undefined {
  if (!line) return null;
  const text = line.toString('utf8').trim();
  if (!text) return undefined;
  try {
    const event = JSON.parse(text) as HarnessEvent;
    return event && typeof event === 'object' && typeof event.seq === 'number'
      && Number.isSafeInteger(event.seq) && event.seq > 0 ? event : null;
  } catch { return null; }
}

/** 日志超过上限:只留最近 JOURNAL_KEEP_BYTES(从行边界开始),原子替换。只在建索引时调用,那时还没有写入在进行。 */
export async function rollJournal(logPath: string, size: number): Promise<number> {
  const handle = await fsp.open(logPath, 'r');
  let start: number;
  try {
    const probe = Buffer.alloc(Math.min(MAX_RECORD_BYTES, size));
    const from = size - JOURNAL_KEEP_BYTES;
    const { bytesRead } = await handle.read(probe, 0, probe.length, from);
    const newline = probe.subarray(0, bytesRead).indexOf(10);
    if (newline < 0) return size;
    start = from + newline + 1;
  } finally { await handle.close(); }
  const temp = `${logPath}.roll`;
  await pipeline(fs.createReadStream(logPath, { start }), fs.createWriteStream(temp, { mode: 0o600 }));
  await fsp.rename(temp, logPath);
  return size - start;
}

/** 尾部 bytes 字节里最后一条完整事件;文件不存在或为空 'empty',尾部里没有完整事件(超长记录)'none'。 */
export async function readTailEvent(logPath: string, bytes: number): Promise<HarnessEvent | 'empty' | 'none'> {
  let handle: fsp.FileHandle;
  try { handle = await fsp.open(logPath, 'r'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'empty'; throw error; }
  try {
    const size = (await handle.stat()).size;
    if (size === 0) return 'empty';
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const rows = buffer.toString('utf8').split('\n');
    if (size > length) rows.shift(); // 从文件中间开始读,第一段不完整
    for (let i = rows.length - 1; i >= 0; i--) {
      const event = eventFromLine(Buffer.from(rows[i]!));
      if (event) return event;
    }
    return 'none';
  } finally { await handle.close(); }
}
