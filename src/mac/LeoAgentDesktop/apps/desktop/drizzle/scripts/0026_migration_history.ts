/**
 * 0026 backfill — migration_history 表回填。
 *
 * 本次 0026 引入 `migration_history` 表用于后续 schema-drift detection (#37)。
 * SQL 部分只 CREATE TABLE；行内的 TS 脚本负责把所有 seq <= 当前 schema_version
 * 的 `NNNN_xxx.sql` 文件 hash 写入历史表,作为「初始指纹」。
 *
 * 设计说明:
 * - 「初始指纹」用当前磁盘 hash —— 因此**无法回溯检测已有 drift**(如果用户本地
 *   schema_version=22 但物理表缺 0022_main 该加的列,backfill 写入的也是当前
 *   0022_main.sql 的 hash,跟磁盘一致,后续 hash detector 不会报警)。这种存量
 *   drift 由 dev 端首次启动时的 schemaDriftRepair 反射补齐兜底。后续实践发现已发布
 *   migration 被改写也会让正式用户产生 hash drift，因此当前启动流程另有精确 hash
 *   兼容层；未知 drift 仍保留告警。
 * - 0026 自身的 history 行由 migrate.ts 在 writeSchemaVersion 同事务内写入,
 *   这里只回填 0..(current-1)。
 * - Idempotent: INSERT OR IGNORE,重复跑无副作用。
 */

import type Database from 'better-sqlite3';

// 跟 0024/0025 保持一致:CJS require,避免 Node type-stripping 把脚本当 ESM 处理
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('node:fs') as typeof import('node:fs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('node:path') as typeof import('node:path');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const crypto = require('node:crypto') as typeof import('node:crypto');

/**
 * 计算 migration sql 文件的内容指纹。
 * normalize 一下行尾(Windows checkout 可能是 CRLF),确保跨平台一致。
 */
function hashMigrationFile(filePath: string): string {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const normalized = raw.replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function readSchemaVersion(db: Database.Database): number {
  try {
    const row = db
      .prepare(`SELECT value FROM migration_meta WHERE key='schema_version'`)
      .get() as { value: string } | undefined;
    return row ? parseInt(row.value, 10) : -1;
  } catch {
    return -1;
  }
}

function run(db: Database.Database): void {
  // 这个脚本被 migrate.ts 的 `require(tsScriptPath)` 加载,
  // __dirname = <repo>/apps/desktop/drizzle/scripts (dev)
  //          = <resourcesPath>/drizzle/scripts (packaged)
  const drizzleDir = path.resolve(__dirname, '..');

  // 此时 0026 的 SQL 刚跑完(migration_history 表已存在),
  // 但 writeSchemaVersion(26) 还没执行,readSchemaVersion 拿到的是上一次的版本号。
  const currentVersion = readSchemaVersion(db);
  if (currentVersion < 0) {
    // 全新 DB,什么都还没 apply (理论上不会进 0026 脚本,但兜底)
    return;
  }

  let files: string[];
  try {
    files = fs.readdirSync(drizzleDir).filter((f) => /^\d{4}_.*\.sql$/.test(f));
  } catch {
    return;
  }

  const insert = db.prepare(
    `INSERT OR IGNORE INTO migration_history (seq, file_name, content_hash, applied_at)
     VALUES (?, ?, ?, ?)`,
  );
  const now = Date.now();

  for (const fileName of files) {
    const seq = parseInt(fileName.slice(0, 4), 10);
    // 只回填已 applied 的(seq <= currentVersion);0026 自身和未来的 migration 不管
    if (seq > currentVersion) continue;
    const filePath = path.join(drizzleDir, fileName);
    let hash: string;
    try {
      hash = hashMigrationFile(filePath);
    } catch {
      // 文件读不出来(权限问题等),写一个 sentinel,后续 detector 会报 missing
      hash = '<unreadable>';
    }
    insert.run(seq, fileName, hash, now);
  }
}

module.exports = { run };
