import type Database from 'better-sqlite3';

interface MigrationLineageEntry {
  seq: number;
  legacyFileName: string;
  legacyHash: string;
  canonicalFileName: string;
  canonicalHash: string;
}

interface MigrationHistoryRow {
  seq: number;
  file_name: string;
  content_hash: string;
}

/**
 * 旧 XDMaker 分支实际发布过的一整组 migration lineage。必须五条全部精确匹配才桥接；
 * 单条或部分匹配可能来自其它分支，不能凭序号猜测并覆盖 migration_history。
 */
const LEGACY_LINEAGE: readonly MigrationLineageEntry[] = [
  {
    seq: 47,
    legacyFileName: '0047_add_session_summary.sql',
    legacyHash: '44c224320ca6f5059d5184deae8f5d074f97bfa6502f3d73a54894a962edaf15',
    canonicalFileName: '0047_lame_malice.sql',
    canonicalHash: '06bfc3ee9e88b6c12fe951e027fb45d647d2a6d20b9745e611f8abf0e6e1d3de',
  },
  {
    seq: 60,
    legacyFileName: '0060_orange_penance.sql',
    legacyHash: 'd1dcd9ee1279ef86f5e0a136b8e1b786b11d462373f8ed464476ae3062312ffb',
    canonicalFileName: '0060_orange_penance.sql',
    canonicalHash: 'c102a337791107a5e5e747851b259b7fe77e6e3452e878977c174da7e51b9240',
  },
  {
    seq: 62,
    legacyFileName: '0062_third_pepper_potts.sql',
    legacyHash: '8a3ba2f92ebc495995f23a3727a65398fce1a877ffcb08d99df8705f21f49837',
    canonicalFileName: '0062_flaky_mimic.sql',
    canonicalHash: '77b8741ac31c159eb422746c0165d102ad65693236c80d0ff055fd70cd43fe68',
  },
  {
    seq: 63,
    legacyFileName: '0063_secret_dreaming_celestial.sql',
    legacyHash: 'd07bdac33796fe1ba80230207f0bf5834d0bf9c9df0c68fe372cbbba42bc7ee8',
    canonicalFileName: '0063_handy_tenebrous.sql',
    canonicalHash: '25951e494866345cbbd0cf9031b486d086598f94ed95bbca137905381aed814a',
  },
  {
    seq: 64,
    legacyFileName: '0064_amusing_white_tiger.sql',
    legacyHash: 'ef297d4140b49cb3f6e87d58ea76e7f5a427fc6b3857a02210b9108650dcab23',
    canonicalFileName: '0064_icy_bruce_banner.sql',
    canonicalHash: '94b35ed3f35d5908bd6810007e3017c761b5e68ac6b3b43e80b22aed0b89feae',
  },
];

function tableColumnNames(db: Database.Database, tableName: string): Set<string> {
  return new Set(
    db
      .prepare(`PRAGMA table_info('${tableName}')`)
      .all()
      .map((row) => String((row as { name: unknown }).name)),
  );
}

function hasExactLegacyLineage(db: Database.Database): boolean {
  const seqs = LEGACY_LINEAGE.map((entry) => entry.seq);
  const rows = db
    .prepare(
      `SELECT seq, file_name, content_hash
       FROM migration_history
       WHERE seq IN (${seqs.map(() => '?').join(', ')})
       ORDER BY seq`,
    )
    .all(...seqs) as MigrationHistoryRow[];

  return (
    rows.length === LEGACY_LINEAGE.length &&
    LEGACY_LINEAGE.every((expected, index) => {
      const actual = rows[index];
      return (
        actual?.seq === expected.seq &&
        actual.file_name === expected.legacyFileName &&
        actual.content_hash === expected.legacyHash
      );
    })
  );
}

/** 补齐 canonical 0047/0060/0062/0063/0064 的真实 schema 与数据语义。 */
function applyCanonicalSemantics(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_aliases (
      project_key TEXT PRIMARY KEY NOT NULL,
      alias TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_project_aliases_updated_at
      ON project_aliases (updated_at);
    CREATE TABLE IF NOT EXISTS device_link_ownership (
      id INTEGER PRIMARY KEY NOT NULL,
      owner_id TEXT NOT NULL,
      owner_pid INTEGER NOT NULL,
      owner_label TEXT,
      heartbeat_at INTEGER NOT NULL
    );
  `);

  const sessionColumns = tableColumnNames(db, 'sessions');
  if (!sessionColumns.has('plan_mode_enabled')) {
    db.exec('ALTER TABLE sessions ADD COLUMN plan_mode_enabled integer DEFAULT false NOT NULL');
  }
  if (!sessionColumns.has('active_turn_started_at')) {
    db.exec('ALTER TABLE sessions ADD COLUMN active_turn_started_at integer');
  }
  if (!sessionColumns.has('active_turn_pid')) {
    db.exec('ALTER TABLE sessions ADD COLUMN active_turn_pid integer');
  }

  const runColumns = tableColumnNames(db, 'schedule_runs');
  if (!runColumns.has('heartbeat_at')) {
    db.exec('ALTER TABLE schedule_runs ADD COLUMN heartbeat_at integer');
  }

  // 0060 不只是加列：旧 permission_mode='plan' 必须迁成独立 plan 开关。
  db.prepare(
    `UPDATE sessions
     SET plan_mode_enabled = 1, permission_mode = 'ask'
     WHERE permission_mode = 'plan'`,
  ).run();
}

/** schema / 数据全部成功后，以 CAS 方式把五条历史记录收敛到 canonical lineage。 */
function canonicalizeMigrationHistory(db: Database.Database): void {
  const update = db.prepare(
    `UPDATE migration_history
     SET file_name = ?, content_hash = ?
     WHERE seq = ? AND file_name = ? AND content_hash = ?`,
  );
  for (const entry of LEGACY_LINEAGE) {
    const result = update.run(
      entry.canonicalFileName,
      entry.canonicalHash,
      entry.seq,
      entry.legacyFileName,
      entry.legacyHash,
    );
    if (result.changes !== 1) {
      throw new Error(`legacy migration lineage changed during bridge at seq ${entry.seq}`);
    }
  }
}

function run(db: Database.Database): void {
  if (!hasExactLegacyLineage(db)) return;

  // migrationRunner 外层已有事务；这里再包一层 savepoint，保证脚本被定向调用时也原子。
  db.transaction(() => {
    applyCanonicalSemantics(db);
    canonicalizeMigrationHistory(db);
  })();
}

module.exports = { run };
