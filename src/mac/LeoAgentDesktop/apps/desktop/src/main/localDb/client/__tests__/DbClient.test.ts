import { describe, expect, it } from 'vitest';

import { createDbClient } from '../DbClient.js';

describe('DbClient', () => {
  it('runs query/exec and disposes idempotently with the inline worker contract', async () => {
    const client = await createDbClient({ useInlineWorker: true });
    try {
      await client.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
      const inserted = await client.exec('INSERT INTO t (name) VALUES (?)', ['alice']);
      expect(inserted.changes).toBe(1);

      const rows = await client.query<{ id: number; name: string }>(
        'SELECT id, name FROM t WHERE name = ?',
        ['alice'],
      );
      expect(rows).toEqual([{ id: 1, name: 'alice' }]);

      const row = await client.queryOne<{ id: number; name: string }>(
        'SELECT id, name FROM t WHERE id = ?',
        [1],
      );
      expect(row).toEqual({ id: 1, name: 'alice' });
    } finally {
      await client.dispose();
      await client.dispose();
    }
  });

  it('falls back to worker-thread when utility-process is requested', async () => {
    const client = await createDbClient({ transport: 'utility-process', useInlineWorker: true });
    try {
      // Should not throw — utility-process falls back to worker-thread
      await client.exec('CREATE TABLE fallback_test (id INTEGER PRIMARY KEY)');
      const rows = await client.query<{ id: number }>('SELECT id FROM fallback_test');
      expect(rows).toEqual([]);
    } finally {
      await client.dispose();
    }
  });

  it('falls back to worker-thread when XDT_DB_TRANSPORT=utility-process', async () => {
    const previous = process.env.XDT_DB_TRANSPORT;
    process.env.XDT_DB_TRANSPORT = 'utility-process';
    try {
      const client = await createDbClient({ useInlineWorker: true });
      try {
        await client.exec('CREATE TABLE env_fallback_test (id INTEGER PRIMARY KEY)');
        const rows = await client.query<{ id: number }>('SELECT id FROM env_fallback_test');
        expect(rows).toEqual([]);
      } finally {
        await client.dispose();
      }
    } finally {
      if (previous === undefined) {
        delete process.env.XDT_DB_TRANSPORT;
      } else {
        process.env.XDT_DB_TRANSPORT = previous;
      }
    }
  });
});
