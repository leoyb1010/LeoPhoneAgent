import fs, { promises as fsp } from 'node:fs';
import path from 'node:path';
import { setImmediate as yieldImmediate } from 'node:timers/promises';

import type { HarnessEvent } from './harness-dialects.js';

export type JournalGap = { from: number; to: number; reason: string };
export type JournalHealth = {
  state: 'pending' | 'durable' | 'degraded';
  durable_seq: number;
  persisted_seq: number;
  latest_seq: number;
  pending_bytes: number;
  pending_events: number;
  dropped_events: number;
  missing_ranges: JournalGap[];
  missing_ranges_truncated?: boolean;
  error: string | null;
};
export type JournalOptions = {
  maxPendingBytes?: number;
  reservedCriticalBytes?: number;
  maxPendingEvents?: number;
  retryDelayMs?: number;
  /** Fault/latency injection at the I/O boundary; production does not provide it. */
  beforeWrite?: () => Promise<void>;
  onCommitted?: (event: HarnessEvent) => void;
  onStateChanged?: () => void;
};
export type JournalPage = {
  events: HarnessEvent[];
  next_after: number;
  next_offset: number;
  snapshot_end: number;
  has_more: boolean;
  bytes_read: number;
};

type PendingRecord = { event: HarnessEvent; line: Buffer; critical: boolean };
type Checkpoint = { seq: number; offset: number };
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_CHECKPOINTS = 8192;
const MAX_GAPS = 256;

/** Bounded line decoding: an oversized or incomplete row is never parsed as an event. */
async function* journalLines(logPath: string, start: number, end: number, signal?: AbortSignal): AsyncGenerator<{
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

function eventFromLine(line: Buffer | null): HarnessEvent | null | undefined {
  if (!line) return null;
  const text = line.toString('utf8').trim();
  if (!text) return undefined;
  try {
    const event = JSON.parse(text) as HarnessEvent;
    return event && typeof event === 'object' && typeof event.seq === 'number'
      && Number.isSafeInteger(event.seq) && event.seq > 0 ? event : null;
  } catch { return null; }
}

/** One ordered asynchronous writer and a sparse seek index per NDJSON journal. */
export class HarnessJournal {
  private readonly pending: PendingRecord[] = [];
  private pendingBytes = 0;
  private latestSeq = 0;
  private persistedSeq = 0;
  private committedOffset = 0;
  private rowCount = 0;
  private stride = 128;
  private checkpoints: Checkpoint[] = [];
  private gaps: JournalGap[] = [];
  private gapsTruncated = false;
  private uncertainAfter: number | null = null;
  private dropped = 0;
  private lastError: string | null = null;
  private initialized: Promise<void> | null = null;
  private pumping = false;
  private closed = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private repairOffset: number | null = null;
  private needsNewline = false;
  private readonly waiters = new Set<() => void>();
  private readonly maxBytes: number;
  private readonly reservedBytes: number;
  private readonly maxEvents: number;

  constructor(readonly logPath: string, private readonly options: JournalOptions = {}) {
    this.maxBytes = options.maxPendingBytes ?? 8 * 1024 * 1024;
    this.reservedBytes = Math.min(options.reservedCriticalBytes ?? 2 * 1024 * 1024, this.maxBytes);
    this.maxEvents = options.maxPendingEvents ?? 2048;
  }

  health(): JournalHealth {
    const earliestGap = this.gaps[0]?.from;
    const durable = Math.min(this.persistedSeq, earliestGap === undefined ? Infinity : earliestGap - 1,
      this.uncertainAfter ?? Infinity);
    return {
      state: this.lastError || this.gaps.length || this.uncertainAfter !== null ? 'degraded'
        : this.pending.length || this.pumping ? 'pending' : 'durable',
      durable_seq: Math.max(0, durable), persisted_seq: this.persistedSeq, latest_seq: this.latestSeq,
      pending_bytes: this.pendingBytes, pending_events: this.pending.length, dropped_events: this.dropped,
      missing_ranges: this.gaps.map((gap) => ({ ...gap })),
      ...(this.gapsTruncated ? { missing_ranges_truncated: true } : {}), error: this.lastError,
    };
  }

  private notify(): void {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
    try { this.options.onStateChanged?.(); } catch { /* observers never control the writer */ }
  }

  private gap(from: number, to: number, reason: string): void {
    if (to < from) return;
    this.gaps.push({ from, to, reason });
    this.gaps.sort((a, b) => a.from - b.from);
    const merged: JournalGap[] = [];
    for (const item of this.gaps) {
      const previous = merged.at(-1);
      if (previous && item.from <= previous.to + 1) {
        previous.to = Math.max(previous.to, item.to);
        if (previous.reason !== item.reason) previous.reason = 'multiple';
      } else merged.push({ ...item });
    }
    if (merged.length > MAX_GAPS) {
      this.gapsTruncated = true;
      this.gaps = [merged[0], ...merged.slice(-(MAX_GAPS - 1))];
    } else this.gaps = merged;
  }

  private index(event: HarnessEvent, offset: number): void {
    const seq = Number(event.seq);
    if (seq <= this.persistedSeq) {
      this.uncertainAfter = Math.min(this.uncertainAfter ?? Infinity, seq - 1);
      this.lastError = 'non_monotonic_sequence';
      return;
    }
    if (seq > this.persistedSeq + 1) this.gap(this.persistedSeq + 1, seq - 1, 'missing_sequence');
    if (this.rowCount++ % this.stride === 0) this.checkpoints.push({ seq, offset });
    if (this.checkpoints.length > MAX_CHECKPOINTS) {
      this.checkpoints = this.checkpoints.filter((_, i) => i % 2 === 0);
      this.stride *= 2;
    }
    this.persistedSeq = Math.max(this.persistedSeq, seq);
    this.latestSeq = Math.max(this.latestSeq, seq);
  }

  async initialize(): Promise<void> {
    if (!this.initialized) {
      this.initialized = (async () => {
        let size: number;
        try { size = (await fsp.stat(this.logPath)).size; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
        for await (const row of journalLines(this.logPath, 0, size)) {
          const event = eventFromLine(row.line);
          if (event === null) {
            this.uncertainAfter ??= this.persistedSeq;
            this.lastError = 'corrupt_record';
          } else if (event?.seq) this.index(event, row.start);
          this.committedOffset = row.end;
        }
        if (size > 0) {
          const handle = await fsp.open(this.logPath, 'r');
          try {
            const last = Buffer.alloc(1);
            await handle.read(last, 0, 1, size - 1);
            this.needsNewline = last[0] !== 10;
          } finally { await handle.close(); }
        }
        this.notify();
      })().catch((error) => { this.initialized = null; throw error; });
    }
    await this.initialized;
  }

  enqueue(event: HarnessEvent, critical: boolean): 'pending' | 'unavailable' {
    const seq = Number(event.seq);
    this.latestSeq = Math.max(this.latestSeq, seq);
    let line: Buffer;
    try { line = Buffer.from(JSON.stringify({ ...event, durability: 'durable' }) + '\n'); }
    catch {
      this.gap(seq, seq, 'serialization_failed'); this.dropped++; this.lastError = 'serialization_failed'; this.notify();
      return 'unavailable';
    }
    const eventLimit = critical ? this.maxEvents : this.maxEvents - Math.min(64, Math.ceil(this.maxEvents / 4));
    const byteLimit = critical ? this.maxBytes : this.maxBytes - this.reservedBytes;
    if (this.closed || line.length > MAX_RECORD_BYTES || this.pending.length >= eventLimit || this.pendingBytes + line.length > byteLimit) {
      const reason = this.closed ? 'journal_closed' : line.length > MAX_RECORD_BYTES ? 'record_too_large' : 'queue_overflow';
      this.gap(seq, seq, reason); this.dropped++; this.lastError = reason; this.notify();
      return 'unavailable';
    }
    this.pending.push({ event: { ...event }, line, critical });
    this.pendingBytes += line.length;
    this.notify();
    this.schedule();
    return 'pending';
  }

  pendingEvents(after: number): HarnessEvent[] {
    return this.pending.filter((record) => Number(record.event.seq) > after)
      .map((record) => ({ ...record.event, durability: 'pending' }));
  }

  private schedule(delay = 0): void {
    if (this.closed || this.pumping || this.retryTimer || this.pending.length === 0) return;
    if (delay) {
      this.retryTimer = setTimeout(() => { this.retryTimer = null; this.schedule(); }, delay);
      this.retryTimer.unref?.();
      return;
    }
    this.pumping = true;
    queueMicrotask(() => { void this.pump(); });
  }

  private async writeBatch(batch: PendingRecord[]): Promise<void> {
    await this.initialize();
    await this.options.beforeWrite?.();
    await fsp.mkdir(path.dirname(this.logPath), { recursive: true, mode: 0o700 });
    const handle = await fsp.open(this.logPath, 'a+', 0o600);
    const prefix = this.needsNewline ? Buffer.from('\n') : Buffer.alloc(0);
    const data = Buffer.concat([prefix, ...batch.map((record) => record.line)]);
    let attemptedWrite = false;
    try {
      await handle.chmod(0o600);
      if (this.repairOffset !== null) await handle.truncate(this.repairOffset);
      if ((await handle.stat()).size !== this.committedOffset) throw new Error('journal_changed');
      attemptedWrite = true;
      let written = 0;
      while (written < data.length) {
        const result = await handle.write(data, written, data.length - written);
        if (result.bytesWritten === 0) throw new Error('zero_byte_write');
        written += result.bytesWritten;
      }
      // "durable" means the batch passed fsync, not merely that it reached a userspace buffer.
      await handle.sync();
    } catch (error) {
      if (attemptedWrite) this.repairOffset = this.committedOffset;
      throw error;
    } finally { await handle.close(); }
    let offset = this.committedOffset + prefix.length;
    for (const record of batch) { this.index(record.event, offset); offset += record.line.length; }
    this.committedOffset = offset;
    this.needsNewline = false;
    this.repairOffset = null;
  }

  private async pump(): Promise<void> {
    let failed = false;
    try {
      while (this.pending.length && !this.closed) {
        const batch: PendingRecord[] = [];
        let bytes = 0;
        for (const record of this.pending) {
          if (batch.length >= 64 || (batch.length && bytes + record.line.length > 256 * 1024)) break;
          batch.push(record); bytes += record.line.length;
        }
        await this.writeBatch(batch);
        this.pending.splice(0, batch.length);
        this.pendingBytes -= bytes;
        this.lastError = this.gaps.length ? 'missing_events' : this.uncertainAfter !== null ? 'corrupt_record' : null;
        for (const record of batch) {
          try { this.options.onCommitted?.({ ...record.event, durability: 'durable' }); }
          catch { /* relay delivery is separate from journal persistence */ }
        }
        this.notify();
      }
    } catch (error) {
      this.lastError = (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : 'write_failed');
      failed = true;
    } finally {
      this.pumping = false;
      this.notify();
      if (failed) this.schedule(this.options.retryDelayMs ?? 1000);
    }
  }

  async flush(timeoutMs = 2000): Promise<JournalHealth> {
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.schedule();
    const deadline = Date.now() + timeoutMs;
    while ((this.pending.length || this.pumping) && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { this.waiters.delete(wake); resolve(); }, Math.max(1, Math.min(100, deadline - Date.now())));
        const wake = () => { clearTimeout(timer); resolve(); };
        this.waiters.add(wake);
      });
    }
    if (this.pending.length && !this.lastError) { this.lastError = 'flush_timeout'; this.notify(); }
    return this.health();
  }

  async readPage(after = 0, options: { limit?: number; maxBytes?: number; offset?: number; end?: number; signal?: AbortSignal } = {}): Promise<JournalPage> {
    await this.initialize();
    const end = Math.min(options.end ?? this.committedOffset, this.committedOffset);
    let offset = options.offset;
    if (offset === undefined) {
      let low = 0, high = this.checkpoints.length - 1;
      offset = 0;
      while (low <= high) {
        const mid = (low + high) >>> 1;
        if (this.checkpoints[mid].seq <= after) { offset = this.checkpoints[mid].offset; low = mid + 1; }
        else high = mid - 1;
      }
    }
    const events: HarnessEvent[] = [];
    const limit = Math.min(1000, Math.max(1, options.limit ?? 256));
    const maxBytes = Math.min(MAX_RECORD_BYTES, Math.max(1024, options.maxBytes ?? 1024 * 1024));
    let payloadBytes = 0, bytesRead = 0, nextOffset = offset, nextAfter = after;
    for await (const row of journalLines(this.logPath, offset, end, options.signal)) {
      bytesRead = row.bytesRead;
      const event = eventFromLine(row.line);
      if (event?.seq && Number(event.seq) > nextAfter) {
        if (events.length && payloadBytes + (row.line?.length ?? 0) > maxBytes) break;
        events.push({ ...event, durability: 'durable' });
        payloadBytes += row.line?.length ?? 0;
        nextAfter = Number(event.seq);
      }
      nextOffset = row.end;
      if (events.length >= limit) break;
    }
    return { events, next_after: nextAfter, next_offset: nextOffset, snapshot_end: end, has_more: nextOffset < end, bytes_read: bytesRead };
  }

  async *replay(after = 0, signal?: AbortSignal): AsyncGenerator<HarnessEvent> {
    await this.initialize();
    const end = this.committedOffset;
    let offset: number | undefined;
    for (;;) {
      const page = await this.readPage(after, { offset, end, signal });
      for (const event of page.events) yield event;
      if (!page.has_more) return;
      offset = page.next_offset;
      after = page.next_after;
    }
  }

  async close(timeoutMs = 2000): Promise<JournalHealth> {
    const state = await this.flush(timeoutMs);
    this.closed = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    return state;
  }

  /** 丢掉 seq 以及之后的行。下一轮从截断处接着写。 */
  async rewindBefore(seq: number): Promise<{ kept: number }> {
    if (!Number.isSafeInteger(seq) || seq <= 0) throw new Error('没有上一轮');
    await this.flush();
    await this.initialize();
    if (this.pending.length) throw new Error('journal still pending');
    const end = this.committedOffset;
    let cut = end;
    for await (const row of journalLines(this.logPath, 0, end)) {
      const event = eventFromLine(row.line);
      if (event?.seq && event.seq >= seq) {
        cut = row.start;
        break;
      }
    }
    if (cut < end) {
      const handle = await fsp.open(this.logPath, 'r+');
      try {
        await handle.truncate(cut);
        await handle.sync();
      } finally { await handle.close(); }
    }
    this.latestSeq = 0;
    this.persistedSeq = 0;
    this.committedOffset = 0;
    this.rowCount = 0;
    this.stride = 128;
    this.checkpoints = [];
    this.gaps = [];
    this.gapsTruncated = false;
    this.uncertainAfter = null;
    this.dropped = 0;
    this.lastError = null;
    this.initialized = null;
    this.needsNewline = false;
    this.repairOffset = null;
    await this.initialize();
    return { kept: this.persistedSeq };
  }
}
