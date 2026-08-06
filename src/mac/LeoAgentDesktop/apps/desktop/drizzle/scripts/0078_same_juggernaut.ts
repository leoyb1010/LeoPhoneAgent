import type Database from 'better-sqlite3';

interface WorkerLabelRow {
  id: string;
  teamId: string;
  label: string;
}

/** 与运行时 worker label 契约一致：ASCII slug、小写、最多 32 字符。 */
function canonicalLabel(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'worker'
  );
}

function nextAvailableLabel(base: string, used: Set<string>): string {
  for (let index = 2; index < 1_000_000; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${base.slice(0, 32 - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(`could not allocate unique worker label for ${base}`);
}

function tableExists(db: Database.Database, tableName: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(tableName) !== undefined
  );
}

/**
 * 每个 canonical label 的最早一条保留原名；后续重复项按创建顺序分配首个空闲后缀。
 * 先预留所有不同的存量 label，避免 duplicate tester 抢走本来就存在的 tester-2。
 */
function normalizeExistingLabels(db: Database.Database): void {
  const rows = db
    .prepare(
      `SELECT id, team_id AS teamId, label
     FROM orca_workers
     WHERE label IS NOT NULL
     ORDER BY team_id, created_at, id`,
    )
    .all() as WorkerLabelRow[];
  const canonicalById = new Map<string, string>();
  const firstIdByTeamLabel = new Map<string, string>();
  const usedByTeam = new Map<string, Set<string>>();

  for (const row of rows) {
    const canonical = canonicalLabel(row.label);
    canonicalById.set(row.id, canonical);
    const key = `${row.teamId}\0${canonical}`;
    if (!firstIdByTeamLabel.has(key)) firstIdByTeamLabel.set(key, row.id);
    const used = usedByTeam.get(row.teamId) ?? new Set<string>();
    used.add(canonical);
    usedByTeam.set(row.teamId, used);
  }

  const update = db.prepare('UPDATE orca_workers SET label = ? WHERE id = ?');
  for (const row of rows) {
    const base = canonicalById.get(row.id);
    if (!base) continue;
    const key = `${row.teamId}\0${base}`;
    const used = usedByTeam.get(row.teamId) ?? new Set<string>();
    const next = firstIdByTeamLabel.get(key) === row.id ? base : nextAvailableLabel(base, used);
    used.add(next);
    if (row.label !== next) update.run(next, row.id);
  }
}

function run(db: Database.Database): void {
  // migration replay 的 lineage bridge 测试会构造只含相关表的部分历史 schema；
  // 该数据库没有 Orca 功能，自然也没有需要迁移的 label/reservation。
  if (!tableExists(db, 'orca_teams') || !tableExists(db, 'orca_workers')) return;
  // migrationRunner 外层已有事务；savepoint 让本脚本被定向调用时也保持全有或全无。
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS orca_worker_creation_reservations (
        id text PRIMARY KEY NOT NULL,
        team_id text NOT NULL REFERENCES orca_teams(id) ON DELETE CASCADE,
        label text NOT NULL,
        created_at integer NOT NULL,
        expires_at integer NOT NULL
      )
    `);
    normalizeExistingLabels(db);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_orca_worker_creation_reservations_team_label
        ON orca_worker_creation_reservations (team_id, lower(label));
      CREATE INDEX IF NOT EXISTS idx_orca_worker_creation_reservations_expires_at
        ON orca_worker_creation_reservations (expires_at);
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_orca_workers_team_label
        ON orca_workers (team_id, lower(label));
    `);
  })();
}

module.exports = { run };
