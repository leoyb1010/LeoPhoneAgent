import { describe, expect, it, vi } from 'vitest';

import { DbErrorBoundary } from '../DbErrorBoundary.js';

describe('DbErrorBoundary', () => {
  it('catches and rethrows RPC errors through wrap', async () => {
    const boundary = new DbErrorBoundary();
    const err = new Error('boom');
    await expect(boundary.wrap('query', async () => {
      throw err;
    })).rejects.toBe(err);
  });

  it('allows one auto restart and blocks subsequent terminations', () => {
    const boundary = new DbErrorBoundary({ maxAutoRestart: 1 });
    expect(boundary.onWorkerTerminated({ code: 1, signal: null })).toEqual({
      shouldRestart: true,
    });
    expect(boundary.onWorkerTerminated({ code: 1, signal: null })).toEqual({
      shouldRestart: false,
    });
  });

  it('does not create unhandledRejection when the wrapped promise rejects and is awaited', async () => {
    const boundary = new DbErrorBoundary();
    const handler = vi.fn();
    process.once('unhandledRejection', handler);
    await expect(boundary.wrap('query', async () => {
      throw new Error('handled');
    })).rejects.toThrow('handled');
    await new Promise((resolve) => setImmediate(resolve));
    expect(handler).not.toHaveBeenCalled();
    process.off('unhandledRejection', handler);
  });
});
