/**
 * Phase 5 verification: detach + reattach replay.
 *
 * Scenarios:
 *   - attach with sinceSeq=0 replays everything from buffer
 *   - attach with sinceSeq=N replays only events with seq > N
 *   - buffer capacity drop → replayLossy flag
 *   - client B replaces client A, A receives 'replaced' notification, B gets replay
 */

import { describe, expect, it, vi } from 'vitest';

import {
  SessionRegistry,
  type SdkQueryFactory,
  type SdkQueryLike,
} from '../src/session-registry.js';

function buildFakeFactory(): SdkQueryFactory {
  return (opts): SdkQueryLike => {
    async function* gen(): AsyncGenerator<unknown> {
      yield { type: 'system', subtype: 'init', session_id: 'sdk-uuid', cwd: opts.cwd, model: opts.model };
      for await (const userMsg of opts.inputStream) {
        yield {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: `echo: ${JSON.stringify(userMsg)}` }] },
        };
        yield { type: 'result', subtype: 'success' };
      }
    }
    const g = gen();
    return {
      [Symbol.asyncIterator]: () => g,
      async interrupt() {},
      async setModel() {},
      async setPermissionMode() {},
      async applyFlagSettings() {},
    };
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('detach + reattach replay', () => {
  it('attach without sinceSeq does not replay (just connects to live stream)', async () => {
    const registry = new SessionRegistry({ sdkQueryFactory: buildFakeFactory() });
    registry.create({ sessionId: 's1', cwd: '/w', model: 'm', env: {} });

    // Wait for init event to be buffered.
    await waitFor(() => registry.list()[0].lastSeq >= 1);

    const events: Array<{ kind: string; payload: unknown }> = [];
    const notify = (kind: string, p: unknown): void => {
      events.push({ kind, payload: p });
    };
    const r = registry.attach('s1', notify);
    expect(r.replayedCount).toBe(0);
    expect(r.currentSeq).toBe(1);
    // No replay → events empty until next live event.
    expect(events).toEqual([]);
  });

  it('attach with sinceSeq=0 replays all buffered events', async () => {
    const registry = new SessionRegistry({ sdkQueryFactory: buildFakeFactory() });
    registry.create({ sessionId: 's1', cwd: '/w', model: 'm', env: {} });

    // Drive 3 events: init + (push 1 msg → assistant + result).
    await waitFor(() => registry.list()[0].lastSeq >= 1);
    registry.sendMessage('s1', { type: 'user', text: 'hi' });
    await waitFor(() => registry.list()[0].lastSeq >= 3);

    const events: Array<{ kind: string; payload: unknown }> = [];
    const notify = (kind: string, p: unknown): void => {
      events.push({ kind, payload: p });
    };
    const r = registry.attach('s1', notify, { sinceSeq: 0 });
    expect(r.replayedCount).toBe(3);
    expect(events).toHaveLength(3);
    expect((events[0].payload as { seq: number }).seq).toBe(1);
    expect((events[1].payload as { seq: number }).seq).toBe(2);
    expect((events[2].payload as { seq: number }).seq).toBe(3);
    expect(r.replayLossy).toBe(false);
  });

  it('attach with sinceSeq=N replays only events with seq > N', async () => {
    const registry = new SessionRegistry({ sdkQueryFactory: buildFakeFactory() });
    registry.create({ sessionId: 's1', cwd: '/w', model: 'm', env: {} });

    await waitFor(() => registry.list()[0].lastSeq >= 1);
    registry.sendMessage('s1', { type: 'user', text: 'a' });
    await waitFor(() => registry.list()[0].lastSeq >= 3);

    const events: unknown[] = [];
    const notify = (_: string, p: unknown): void => {
      events.push(p);
    };
    const r = registry.attach('s1', notify, { sinceSeq: 1 });
    expect(r.replayedCount).toBe(2);
    expect((events[0] as { seq: number }).seq).toBe(2);
    expect((events[1] as { seq: number }).seq).toBe(3);
  });

  it('attach with sinceSeq beyond lastSeq replays nothing', async () => {
    const registry = new SessionRegistry({ sdkQueryFactory: buildFakeFactory() });
    registry.create({ sessionId: 's1', cwd: '/w', model: 'm', env: {} });
    await waitFor(() => registry.list()[0].lastSeq >= 1);

    const events: unknown[] = [];
    const notify = (_: string, p: unknown): void => {
      events.push(p);
    };
    const r = registry.attach('s1', notify, { sinceSeq: 999 });
    expect(r.replayedCount).toBe(0);
    expect(events).toEqual([]);
  });

  it('buffer capacity dropping → replayLossy when sinceSeq below bufferFirstSeq', async () => {
    const registry = new SessionRegistry({
      sdkQueryFactory: buildFakeFactory(),
      bufferCapacity: 2, // tiny buffer to force drops
    });
    registry.create({ sessionId: 's1', cwd: '/w', model: 'm', env: {} });

    // Init = seq 1. Push 2 user messages → 4 more events (echo+result × 2).
    // Total 5 events; with cap 2 only seq 4, 5 remain in buffer.
    await waitFor(() => registry.list()[0].lastSeq >= 1);
    registry.sendMessage('s1', { type: 'user', text: 'a' });
    await waitFor(() => registry.list()[0].lastSeq >= 3);
    registry.sendMessage('s1', { type: 'user', text: 'b' });
    await waitFor(() => registry.list()[0].lastSeq >= 5);

    const events: unknown[] = [];
    const notify = (_: string, p: unknown): void => {
      events.push(p);
    };
    // sinceSeq=0 → client thinks it's resuming from start, but buffer only has 4,5.
    const r = registry.attach('s1', notify, { sinceSeq: 0 });
    expect(r.replayLossy).toBe(true);
    expect(r.replayedCount).toBe(2);
    expect((events[0] as { seq: number }).seq).toBe(4);
    expect((events[1] as { seq: number }).seq).toBe(5);
  });

  it('client B replaces client A → A gets replaced notification, B gets replay', async () => {
    const registry = new SessionRegistry({ sdkQueryFactory: buildFakeFactory() });
    registry.create({ sessionId: 's1', cwd: '/w', model: 'm', env: {} });
    await waitFor(() => registry.list()[0].lastSeq >= 1);

    const aEvents: Array<{ kind: string; payload: unknown }> = [];
    const bEvents: Array<{ kind: string; payload: unknown }> = [];
    const notifyA = vi.fn((kind: string, p: unknown): void => {
      aEvents.push({ kind, payload: p });
    });
    const notifyB = vi.fn((kind: string, p: unknown): void => {
      bEvents.push({ kind, payload: p });
    });

    registry.attach('s1', notifyA);
    // A is now attached; live events go to it. Trigger one more event.
    registry.sendMessage('s1', { type: 'user', text: 'x' });
    await waitFor(() => registry.list()[0].lastSeq >= 3);

    // B attaches with sinceSeq=0 → A gets replaced, B gets full replay.
    const r = registry.attach('s1', notifyB, { sinceSeq: 0 });
    expect(r.replayedCount).toBe(3); // init + assistant + result
    expect(bEvents.filter((e) => e.kind === 'event')).toHaveLength(3);
    // A received at least one 'replaced'.
    expect(aEvents.some((e) => e.kind === 'replaced')).toBe(true);
  });
});
