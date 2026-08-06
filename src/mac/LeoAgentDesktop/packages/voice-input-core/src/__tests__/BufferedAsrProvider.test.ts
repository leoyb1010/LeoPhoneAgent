import { describe, expect, it } from 'vitest';
import { BufferedAsrProvider } from '../BufferedAsrProvider';
import type { AsrEvent, AsrProvider } from '../types';

// Inner provider whose start() only settles when the test releases it, and
// which records every interaction — mirrors a realtime provider whose connect
// handshake is in flight while capture is already producing audio.
class GatedInnerProvider implements AsrProvider {
  appended: ArrayBuffer[] = [];
  startCalls = 0;
  stopCalls = 0;
  flushCalls = 0;
  disposeCalls = 0;
  recover?: () => Promise<void>;
  private callback: (event: AsrEvent) => void = () => {};
  private releases: Array<() => void> = [];
  private fails: Array<(error: Error) => void> = [];

  async start(): Promise<void> {
    this.startCalls += 1;
    await new Promise<void>((resolve, reject) => {
      this.releases.push(resolve);
      this.fails.push(reject);
    });
    this.callback({ type: 'connected', at: Date.now() });
  }

  // Releases every pending start() gate (a provider restarted while a previous
  // handshake is still pending has two gates outstanding).
  resolveStart(): void {
    this.fails = [];
    this.releases.splice(0).forEach((release) => release());
  }

  failStart(error: Error): void {
    this.releases = [];
    this.fails.splice(0).forEach((fail) => fail(error));
  }

  // When true, stop() blocks until resolveStops() — mirrors providers whose
  // stop() awaits async teardown/recovery before returning.
  slowStop = false;
  private stopReleases: Array<() => void> = [];

  async stop(): Promise<void> {
    this.stopCalls += 1;
    if (this.slowStop) {
      await new Promise<void>((resolve) => {
        this.stopReleases.push(resolve);
      });
    }
    // Real realtime providers emit a normal 'disconnected' when stopped.
    this.callback({ type: 'disconnected', at: Date.now() });
  }

  resolveStops(): void {
    this.stopReleases.splice(0).forEach((release) => release());
  }

  appendAudio(chunk: ArrayBuffer): void {
    this.appended.push(chunk);
  }

  async flushAudio(): Promise<void> {
    this.flushCalls += 1;
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
  }

  onEvent(callback: (event: AsrEvent) => void): void {
    this.callback = callback;
  }
}

const buf = (byte: number): ArrayBuffer => new Uint8Array([byte]).buffer;

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('BufferedAsrProvider', () => {
  it('buffers audio during the handshake and replays it in order once start resolves', async () => {
    const inner = new GatedInnerProvider();
    const provider = new BufferedAsrProvider(inner);

    const startPromise = provider.start();
    const a = buf(1);
    const b = buf(2);
    provider.appendAudio(a);
    provider.appendAudio(b);
    expect(inner.appended).toEqual([]);

    inner.resolveStart();
    await startPromise;
    expect(inner.appended).toEqual([a, b]);

    const c = buf(3);
    provider.appendAudio(c);
    expect(inner.appended).toEqual([a, b, c]);
  });

  it('flushAudio waits for the in-flight handshake so buffered audio is replayed before the flush', async () => {
    const inner = new GatedInnerProvider();
    const provider = new BufferedAsrProvider(inner);

    const startPromise = provider.start();
    const a = buf(9);
    provider.appendAudio(a);

    let flushed = false;
    const flushPromise = provider.flushAudio().then(() => {
      flushed = true;
    });
    await settle();
    expect(flushed).toBe(false);
    expect(inner.flushCalls).toBe(0);

    inner.resolveStart();
    await startPromise;
    await flushPromise;
    expect(inner.appended).toEqual([a]);
    expect(inner.flushCalls).toBe(1);
  });

  it('stop during the handshake returns immediately, discards the buffer, and tears the inner provider down when the handshake settles', async () => {
    const inner = new GatedInnerProvider();
    const provider = new BufferedAsrProvider(inner);

    const startPromise = provider.start();
    provider.appendAudio(buf(1));

    // Cancel must not block on the pending connect.
    await provider.stop();
    expect(inner.stopCalls).toBe(0);

    // The late handshake must not revive the run: no replay, and the
    // just-opened inner provider is closed instead of leaking.
    inner.resolveStart();
    await startPromise;
    expect(inner.appended).toEqual([]);
    expect(inner.stopCalls).toBe(1);

    // Audio after the abort is dropped, and flushAudio is a no-op.
    provider.appendAudio(buf(2));
    await provider.flushAudio();
    expect(inner.appended).toEqual([]);
    expect(inner.flushCalls).toBe(0);
  });

  it('propagates start failure, drops the buffer, and keeps flushAudio a no-op', async () => {
    const inner = new GatedInnerProvider();
    const provider = new BufferedAsrProvider(inner);

    const startPromise = provider.start();
    provider.appendAudio(buf(1));
    inner.failStart(new Error('connect failed'));

    await expect(startPromise).rejects.toThrow('connect failed');
    await provider.flushAudio();
    expect(inner.appended).toEqual([]);
    expect(inner.flushCalls).toBe(0);

    // stop() after a settled (failed) handshake still forwards to the inner
    // provider so its own teardown/idempotence applies.
    await provider.stop();
    expect(inner.stopCalls).toBe(1);
  });

  it('closes an abandoned in-flight handshake before starting the next run', async () => {
    const inner = new GatedInnerProvider();
    const provider = new BufferedAsrProvider(inner);

    // Run 1: abandoned mid-handshake.
    const firstStart = provider.start();
    provider.appendAudio(buf(1));
    await provider.stop();

    // Run 2 starts before run 1's handshake settles: it must wait for that
    // handshake, close the connection it opened (no leak until a timeout), and
    // only then open its own.
    const secondStart = provider.start();
    const a = buf(2);
    provider.appendAudio(a);
    expect(inner.startCalls).toBe(1);

    inner.resolveStart();
    await firstStart;
    await settle();
    // Run 1's connection was torn down and run 2's own connect began.
    expect(inner.stopCalls).toBe(1);
    expect(inner.startCalls).toBe(2);

    inner.resolveStart();
    await secondStart;
    // Run 2 is unaffected otherwise: only its own buffer was replayed.
    expect(inner.stopCalls).toBe(1);
    expect(inner.appended).toEqual([a]);
  });

  it('gates a retry on the abandoned teardown completing instead of racing it', async () => {
    const inner = new GatedInnerProvider();
    inner.slowStop = true;
    const provider = new BufferedAsrProvider(inner);

    // Run 1 is abandoned mid-handshake; its handshake then resolves and the
    // continuation begins the (slow) teardown of the just-opened socket.
    const firstStart = provider.start();
    await provider.stop();
    inner.resolveStart();
    await settle();
    expect(inner.stopCalls).toBe(1);

    // Retry while that teardown is still in flight: it must NOT open a new
    // connection concurrently with the old close.
    const secondStart = provider.start();
    await settle();
    expect(inner.startCalls).toBe(1);

    // Teardown completes → the retry drains (second stop) and only then
    // connects.
    inner.resolveStops();
    await firstStart;
    await settle();
    inner.resolveStops();
    await settle();
    expect(inner.startCalls).toBe(2);

    inner.resolveStart();
    await secondStart;
  });

  it('mutes teardown events from a drained prior handshake so they cannot kill the new run', async () => {
    const inner = new GatedInnerProvider();
    const provider = new BufferedAsrProvider(inner);
    const events: AsrEvent[] = [];
    provider.onEvent((event) => events.push(event));

    // Run 1 abandoned mid-handshake, run 2 starts before it settles.
    const firstStart = provider.start();
    await provider.stop();
    const secondStart = provider.start();

    // Run 1's handshake settles: run 2 drains it (inner.stop() emits a normal
    // 'disconnected' from the abandoned socket). That event must NOT reach the
    // consumer, which already considers the new run live.
    inner.resolveStart();
    await firstStart;
    await settle();
    expect(events).toEqual([]);

    // Run 2's own connect proceeds and its events flow normally again.
    inner.resolveStart();
    await secondStart;
    expect(events.map((event) => event.type)).toEqual(['connected']);
  });

  it('exposes recover only while the inner provider does', async () => {
    const inner = new GatedInnerProvider();
    const provider = new BufferedAsrProvider(inner);
    expect(typeof provider.recover).toBe('undefined');

    let recovered = 0;
    inner.recover = async () => {
      recovered += 1;
    };
    expect(typeof provider.recover).toBe('function');
    await provider.recover?.();
    expect(recovered).toBe(1);
  });

  it('forwards events and dispose to the inner provider', async () => {
    const inner = new GatedInnerProvider();
    const provider = new BufferedAsrProvider(inner);
    const events: AsrEvent[] = [];
    provider.onEvent((event) => events.push(event));

    const startPromise = provider.start();
    inner.resolveStart();
    await startPromise;
    expect(events.map((event) => event.type)).toEqual(['connected']);

    await provider.dispose();
    expect(inner.disposeCalls).toBe(1);
  });
});
