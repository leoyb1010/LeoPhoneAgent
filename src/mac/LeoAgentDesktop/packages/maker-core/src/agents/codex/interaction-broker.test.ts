import { describe, expect, it } from 'vitest';

import { CodexInteractionBroker } from './interaction-broker.js';

describe('CodexInteractionBroker', () => {
  const meta = {
    kind: 'dynamic_tool' as const,
    connectionId: 'conn-1',
    requestId: 'req-1',
    threadId: 'thread-1',
  };

  it('clears pending entry when run throws synchronously', async () => {
    const broker = new CodexInteractionBroker<string>();

    await expect(broker.track(meta, () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');

    expect(broker.has(meta)).toBe(false);
    await expect(broker.track(meta, (settle) => settle('ok'))).resolves.toBe('ok');
  });
});
