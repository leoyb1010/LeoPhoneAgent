import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { dispatch, serializeWorkerError } from '../dispatcher.js';

describe('db worker dispatcher', () => {
  it('routes query/exec/raw/run operations', async () => {
    const db = new Database(':memory:');
    try {
      await dispatch('exec', { sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)' }, db);
      const insert = await dispatch('run', {
        sql: 'INSERT INTO t (name) VALUES (?)',
        params: ['alice'],
      }, db);
      expect(insert).toMatchObject({ changes: 1 });
      await expect(dispatch('query', { sql: 'SELECT id, name FROM t' }, db)).resolves.toEqual([
        { id: 1, name: 'alice' },
      ]);
      await expect(dispatch('rawAll', { sql: 'SELECT id, name FROM t' }, db)).resolves.toEqual([
        [1, 'alice'],
      ]);
      await expect(dispatch('rawGet', { sql: 'SELECT id, name FROM t' }, db)).resolves.toEqual([
        1,
        'alice',
      ]);
    } finally {
      db.close();
    }
  });

  it('returns structured error codes for unknown ops and unknown tx names', async () => {
    const db = new Database(':memory:');
    try {
      await expect(dispatch('missing', undefined, db)).rejects.toMatchObject({ code: 'UNKNOWN_OP' });
      await expect(dispatch('tx', { name: 'future' }, db)).rejects.toMatchObject({
        code: 'UNKNOWN_TX',
      });

      const error = await dispatch('missing', undefined, db).catch(serializeWorkerError);
      expect(error).toMatchObject({ code: 'UNKNOWN_OP' });
    } finally {
      db.close();
    }
  });
});
