import { describe, expect, it } from 'vitest';

import { createDbClient } from '../DbClient.js';
import { UtilityProcessTransport } from '../UtilityProcessTransport.js';
import { WorkerThreadTransport } from '../WorkerThreadTransport.js';

describe('DbClient escape hatch', () => {
  it('keeps utility-process and worker-thread transports interface-compatible', async () => {
    const worker = new WorkerThreadTransport({ useInlineWorker: true });
    const utility = new UtilityProcessTransport();
    try {
      for (const method of ['send', 'on', 'onTerminated', 'close'] as const) {
        expect(typeof worker[method]).toBe('function');
        expect(typeof utility[method]).toBe('function');
      }
    } finally {
      await worker.close();
    }
  });

  it('falls back to worker-thread when utility-process is explicitly requested', async () => {
    const client = await createDbClient({
      transport: 'utility-process',
      useInlineWorker: true,
    });
    try {
      await expect(client.query('SELECT 1')).resolves.toEqual([{ '1': 1 }]);
    } finally {
      await client.dispose();
    }
  });
});
