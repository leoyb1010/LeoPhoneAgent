import Database from 'better-sqlite3';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { DriftEntry, DriftReport } from '../schemaDriftCore';
import { detectSchemaDriftInDir } from '../schemaDriftCore';
import { reconcileKnownEquivalentMigrationHashes } from '../schemaDriftCompatibility';

const OLD_0067_HASH = '5f7a4e6b5fa4ac55299acab47e9d085eeabfc488e642a9c0af7e4c20c9b9e02f';
const CURRENT_0067_HASH = '71a1a1f0c17cb33012d1f6f30c471708772bbe77418aa9bf2ef096e74953a06e';

function createHistoryDb(hash = OLD_0067_HASH): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE migration_history (
      seq INTEGER PRIMARY KEY NOT NULL,
      file_name TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
  db.prepare(
    `INSERT INTO migration_history (seq, file_name, content_hash, applied_at)
     VALUES (?, ?, ?, ?)`,
  ).run(67, '0067_freezing_molecule_man.sql', hash, 123);
  return db;
}

function driftEntry(overrides: Partial<DriftEntry> = {}): DriftEntry {
  return {
    seq: 67,
    fileName: '0067_freezing_molecule_man.sql',
    recordedHash: OLD_0067_HASH,
    currentHash: CURRENT_0067_HASH,
    kind: 'drifted',
    ...overrides,
  };
}

function driftReport(entries: DriftEntry[]): DriftReport {
  return { status: 'drifted', entries };
}

describe('reconcileKnownEquivalentMigrationHashes', () => {
  it('canonicalizes the known schema-equivalent 0067 hash without changing applied_at', () => {
    const db = createHistoryDb();
    try {
      const drizzleDir = path.resolve(__dirname, '../../../../drizzle');
      const detected = detectSchemaDriftInDir(db, drizzleDir);
      expect(detected).toEqual({ status: 'drifted', entries: [driftEntry()] });

      const result = reconcileKnownEquivalentMigrationHashes(db, detected);
      const row = db
        .prepare(`SELECT content_hash, applied_at FROM migration_history WHERE seq = 67`)
        .get();

      expect(result.report).toEqual({ status: 'clean', entries: [] });
      expect(result.reconciled).toEqual([
        {
          seq: 67,
          fileName: '0067_freezing_molecule_man.sql',
          from: OLD_0067_HASH,
          to: CURRENT_0067_HASH,
        },
      ]);
      expect(result.failures).toEqual([]);
      expect(row).toEqual({ content_hash: CURRENT_0067_HASH, applied_at: 123 });
      expect(detectSchemaDriftInDir(db, drizzleDir)).toEqual({ status: 'clean', entries: [] });
    } finally {
      db.close();
    }
  });

  it('keeps unknown drift entries unchanged', () => {
    const unknownHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const db = createHistoryDb(unknownHash);
    const entry = driftEntry({ recordedHash: unknownHash });
    try {
      const result = reconcileKnownEquivalentMigrationHashes(db, driftReport([entry]));
      const storedHash = db
        .prepare(`SELECT content_hash FROM migration_history WHERE seq = 67`)
        .pluck()
        .get();

      expect(result.report).toEqual({ status: 'drifted', entries: [entry] });
      expect(result.reconciled).toEqual([]);
      expect(result.failures).toEqual([]);
      expect(storedHash).toBe(unknownHash);
    } finally {
      db.close();
    }
  });

  it('does not report clean when the history row changed before compare-and-swap', () => {
    const changedHash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const db = createHistoryDb(changedHash);
    const entry = driftEntry();
    try {
      const result = reconcileKnownEquivalentMigrationHashes(db, driftReport([entry]));

      expect(result.report).toEqual({ status: 'drifted', entries: [entry] });
      expect(result.reconciled).toEqual([]);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.error).toBeInstanceOf(Error);
    } finally {
      db.close();
    }
  });
});
