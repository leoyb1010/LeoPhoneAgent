import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { getTableName, isTable } from 'drizzle-orm';

import * as localSchema from '../localDb/schema';

vi.mock('../logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

import {
  getManagedSchemaTableNames,
  repairSchemaDrift,
  repairSchemaDriftWithBackup,
} from '../localDb/schemaDriftRepair';

describe('repairSchemaDrift', () => {
  it('derives managed tables from every sqliteTable export in schema.ts', () => {
    const exportedTableNames = Object.values(localSchema)
      .filter(isTable)
      .map((table) => getTableName(table))
      .sort();

    expect(getManagedSchemaTableNames()).toEqual(exportedTableNames);
    expect(getManagedSchemaTableNames()).toEqual(expect.arrayContaining([
      'daily_model_usage',
      'embedding_jobs',
      'embedding_meta',
      'recent_workdirs',
      'session_pr_refs',
      'vec_table_meta',
    ]));
  });

  it('repairs missing partial indexes with their WHERE clauses', () => {
    const db = new Database(':memory:');
    try {
      const report = repairSchemaDrift(db);

      expect(report.residual).toEqual([]);

      const partialIndexes = db.prepare(`
        SELECT name, sql
        FROM sqlite_master
        WHERE type = 'index'
          AND name IN ('uniq_active_team_per_lead', 'uniq_orca_workers_focused_per_team')
      `).all() as Array<{ name: string; sql: string }>;
      expect(partialIndexes).toHaveLength(2);
      expect(partialIndexes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'uniq_active_team_per_lead',
          sql: expect.stringMatching(/WHERE[\s\S]*status[\s\S]*active/i),
        }),
        expect.objectContaining({
          name: 'uniq_orca_workers_focused_per_team',
          sql: expect.stringMatching(/WHERE[\s\S]*focused/i),
        }),
      ]));

      const regularIndex = db.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND name = 'uniq_orca_workers_session_id'
      `).get();
      expect(regularIndex).toBeTruthy();

      const expressionIndexes = db.prepare(`
        SELECT name, sql
        FROM sqlite_master
        WHERE type = 'index'
          AND name IN (
            'uniq_orca_workers_team_label',
            'uniq_orca_worker_creation_reservations_team_label'
          )
      `).all() as Array<{ name: string; sql: string }>;
      expect(expressionIndexes).toHaveLength(2);
      expect(expressionIndexes.every((index) => /\blower\s*\(\s*[`"]?label[`"]?\s*\)/i.test(index.sql))).toBe(true);
      expect(expressionIndexes.every((index) => !index.sql.includes('undefined'))).toBe(true);
    } finally {
      db.close();
    }
  });

  it('does not back up when metadata drift has no physical schema repair actions', async () => {
    const db = new Database(':memory:');
    try {
      // 先构造完整物理 schema；上层即使仍检测到 migration-history drift，也不应备份。
      expect(repairSchemaDrift(db).residual).toEqual([]);
      const backup = vi.fn(async () => '/tmp/should-not-exist');

      const result = await repairSchemaDriftWithBackup(db, { backup });

      expect(result.outcome).toBe('no-op');
      expect(result.plan.actions).toEqual([]);
      expect(backup).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('backs up before a real schema repair and skips backup on the second pass', async () => {
    const db = new Database(':memory:');
    const events: string[] = [];
    try {
      const backup = vi.fn(async () => {
        events.push('backup');
        expect(
          db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_aliases'")
            .get(),
        ).toBeUndefined();
        return '/tmp/schema-drift.bak';
      });

      const first = await repairSchemaDriftWithBackup(db, {
        beforeBackup: () => events.push('prepare'),
        backup,
        afterApply: () => events.push('prune'),
      });

      expect(first.outcome).toBe('applied');
      expect(first.report?.repaired.length).toBeGreaterThan(0);
      expect(first.report?.residual).toEqual([]);
      expect(events).toEqual(['prepare', 'backup', 'prune']);
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_aliases'")
          .get(),
      ).toBeTruthy();

      const second = await repairSchemaDriftWithBackup(db, { backup });
      expect(second.outcome).toBe('no-op');
      expect(backup).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });

  it('does not mutate schema when the required backup fails', async () => {
    const db = new Database(':memory:');
    try {
      const result = await repairSchemaDriftWithBackup(db, {
        backup: async () => null,
      });

      expect(result.outcome).toBe('backup-failed');
      expect(result.plan.actions.length).toBeGreaterThan(0);
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_aliases'")
          .get(),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });

  // 回归(2026-06-22 事故):并发 ensureReady 在 await backupDb 期间把 _db 置 null,
  // 旧路径把 null/已关闭的连接传进来,每张表 db.prepare 抛 TypeError,被误判成 21 个
  // residual → 触发 nuke 删掉一个完好的 340MB 库。null/closed 是基础设施错误,绝不能
  // 产出 residual。
  it('returns an empty report (never residual) when db handle is null', () => {
    const report = repairSchemaDrift(null as unknown as Database.Database);
    expect(report.repaired).toEqual([]);
    expect(report.residual).toEqual([]);
  });

  it('returns an empty report (never residual) when db connection is already closed', () => {
    const db = new Database(':memory:');
    db.close();
    expect(db.open).toBe(false);

    // 不能抛错,也不能产出 residual —— 否则上层会拿着这堆 residual 弹 nuke 对话框。
    const report = repairSchemaDrift(db);
    expect(report.repaired).toEqual([]);
    expect(report.residual).toEqual([]);
  });

  it('records residual when a missing partial index cannot be recreated', () => {
    const db = new Database(':memory:');
    try {
      // 两条 active 记录共享同一个 lead_session_id，会让 partial unique index 创建失败。
      db.exec(`
        CREATE TABLE orca_teams (
          id TEXT PRIMARY KEY,
          lead_session_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO orca_teams (id, lead_session_id, status, created_at, updated_at)
        VALUES ('team-1', 'lead-1', 'active', 1, 1);
        INSERT INTO orca_teams (id, lead_session_id, status, created_at, updated_at)
        VALUES ('team-2', 'lead-1', 'active', 2, 2);
      `);

      const report = repairSchemaDrift(db);

      expect(report.residual).toEqual(expect.arrayContaining([
        expect.objectContaining({
          table: 'orca_teams',
          kind: 'missing-partial-index',
          detail: expect.stringContaining('uniq_active_team_per_lead'),
        }),
      ]));
      const partialIndex = db.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND name = 'uniq_active_team_per_lead'
      `).get();
      expect(partialIndex).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
