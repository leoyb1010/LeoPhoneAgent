import { describe, expect, it, vi } from 'vitest';

import { cleanupStaleOrcaLeadIndex } from '../localDb/orcaStaleIndexCleanup';

// Minimum surface of better-sqlite3 Database we touch in the cleanup function.
// Mocking this avoids loading the native module under vitest (Electron-ABI bound).
function makeDb(opts: {
  schemaVersion?: string | undefined;
  hasStaleIndex: boolean;
  throwOnExec?: boolean;
}) {
  const execCalls: string[] = [];
  const prepareCalls: string[] = [];
  const db = {
    prepare: (sql: string) => {
      prepareCalls.push(sql);
      if (sql.includes('migration_meta')) {
        return {
          get: () =>
            opts.schemaVersion === undefined
              ? undefined
              : { value: opts.schemaVersion },
        };
      }
      if (sql.includes('sqlite_master')) {
        return {
          get: (name: string) => {
            expect(name).toBe('uniq_orca_workflows_lead_session_id');
            return opts.hasStaleIndex ? 1 : undefined;
          },
        };
      }
      throw new Error(`unexpected prepare(${sql})`);
    },
    exec: (sql: string) => {
      execCalls.push(sql);
      if (opts.throwOnExec) throw new Error('boom');
    },
  };
  return { db: db as unknown as import('better-sqlite3').Database, execCalls, prepareCalls };
}

describe('cleanupStaleOrcaLeadIndex', () => {
  it('drops the stale index when schema_version >= 36 and the index exists', () => {
    const { db, execCalls } = makeDb({ schemaVersion: '36', hasStaleIndex: true });
    cleanupStaleOrcaLeadIndex(db);
    expect(execCalls).toEqual([
      'DROP INDEX IF EXISTS `uniq_orca_workflows_lead_session_id`',
    ]);
  });

  it('does nothing when the stale index is absent (no needless writes)', () => {
    const { db, execCalls } = makeDb({ schemaVersion: '36', hasStaleIndex: false });
    cleanupStaleOrcaLeadIndex(db);
    expect(execCalls).toEqual([]);
  });

  it('does nothing when schema_version < 36 (the full unique is still canonical pre-0036)', () => {
    const { db, execCalls } = makeDb({ schemaVersion: '29', hasStaleIndex: true });
    cleanupStaleOrcaLeadIndex(db);
    expect(execCalls).toEqual([]);
  });

  it('does nothing when migration_meta has no schema_version row (fresh / partial DB)', () => {
    const { db, execCalls } = makeDb({ schemaVersion: undefined, hasStaleIndex: true });
    cleanupStaleOrcaLeadIndex(db);
    expect(execCalls).toEqual([]);
  });

  it('does not propagate exec errors (must not block ensureReady)', () => {
    const { db, execCalls } = makeDb({
      schemaVersion: '36',
      hasStaleIndex: true,
      throwOnExec: true,
    });
    // Suppress noisy expected-warn from the logger.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => cleanupStaleOrcaLeadIndex(db)).not.toThrow();
    expect(execCalls).toHaveLength(1);
    warn.mockRestore();
  });
});
