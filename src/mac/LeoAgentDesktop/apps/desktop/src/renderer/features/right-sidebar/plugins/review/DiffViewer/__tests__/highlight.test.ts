// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

type WorkerListener = (event: MessageEvent | ErrorEvent) => void;

class MockHighlightWorker {
  static instances: MockHighlightWorker[] = [];

  readonly listeners = new Map<string, WorkerListener[]>();
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();

  constructor() {
    MockHighlightWorker.instances.push(this);
  }

  addEventListener(type: string, listener: WorkerListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emitError(message: string): void {
    for (const listener of this.listeners.get('error') ?? []) {
      listener(new ErrorEvent('error', { message }));
    }
  }
}

describe('DiffViewer highlight worker', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    MockHighlightWorker.instances = [];
  });

  it('terminates and recreates the worker after an error', async () => {
    vi.stubGlobal('Worker', MockHighlightWorker);
    const { highlightLine } = await import('../highlight');

    const first = highlightLine('typescript', 'const first = 1;');
    expect(MockHighlightWorker.instances).toHaveLength(1);
    MockHighlightWorker.instances[0].emitError('worker crashed');
    await expect(first).resolves.toBeNull();
    expect(MockHighlightWorker.instances[0].terminate).toHaveBeenCalledTimes(1);

    void highlightLine('typescript', 'const second = 2;');
    expect(MockHighlightWorker.instances).toHaveLength(2);
  });
});
