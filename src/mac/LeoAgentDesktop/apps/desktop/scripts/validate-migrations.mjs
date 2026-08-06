#!/usr/bin/env node
/* global console, process */

/**
 * validate-migrations.mjs — drizzle migration 完整性校验（release 前置护栏）。
 *
 * 检查 6 件事，任何一条失败都会 exit(1)：
 *   1. `drizzle/` 下所有 `NNNN_*.sql` 文件的序号严格从 0 开始、连续、无跳号、无重复
 *   2. `drizzle/meta/_journal.json` 的 entries 数量 / tag / idx 与 sql 文件一一对齐；
 *      每个 entry 对应的 snapshot 文件存在；snapshot 链 prevId/id 首尾相接（防"手写
 *      sql 但漏跑 db:generate"导致 prevId 跳过中间 idx）
 *   3. 跑 `drizzle-kit check`（schema drift 检查）返回码必须为 0
 *   4. `meta/` 下 snapshot 文件数量与 journal entries 一致（防孤儿 snapshot）
 *   5. `drizzle/scripts/NNNN_*.ts` 配套迁移脚本必须是 CommonJS（`module.exports = { run }`
 *      + 依赖只用 `import type`），禁止顶层 ESM `export` / value `import`——这些脚本以 raw
 *      形式随包发出（forge extraResource），生产 Electron 用 `require()` 当 CJS 加载，ESM
 *      语法会在用户端炸 `Unexpected token 'export'`（dev/vitest 走 import 不复现，静默生产坑）
 *   6. 从旧仓迁入的固定 SHA256 基线，以及已进入新仓 main/PR base 的 migration SQL +
 *      companion TS runtime identity 不可增删或修改，只允许追加新 migration
 *
 * 通过 → stdout 输出 `✅ migration validation passed: 0000..<max> ... + historical runtime identities frozen`
 *
 * 使用：
 *   pnpm db:validate
 *
 * Windows/macOS/Linux 通用；在 apps/desktop/ 下运行（cwd 自动定位）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { validateMigrationFreeze } from './lib/migration-freeze.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DESKTOP_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(DESKTOP_ROOT, '..', '..');
const DRIZZLE_DIR = path.join(DESKTOP_ROOT, 'drizzle');
const META_DIR = path.join(DRIZZLE_DIR, 'meta');
const JOURNAL_PATH = path.join(META_DIR, '_journal.json');

/**
 * 失败时统一打印格式 + exit 1。
 * @param {string} msg
 */
function fail(msg) {
  console.error(`[db:validate] FAIL: ${msg}`);
  process.exit(1);
}

function info(msg) {
  console.log(`[db:validate] ${msg}`);
}

// ── 1. 扫描 sql 文件、校验序号 ────────────────────────────────────────────

if (!fs.existsSync(DRIZZLE_DIR)) {
  fail(`drizzle 目录不存在：${DRIZZLE_DIR}`);
}

/** @type {{ seq: number, file: string, tag: string }[]} */
const sqlFiles = [];
for (const entry of fs.readdirSync(DRIZZLE_DIR, { withFileTypes: true })) {
  // 忽略 meta/ 和 scripts/ 子目录 —— 它们不是 migration sql
  if (entry.isDirectory()) continue;
  if (!entry.isFile()) continue;
  const match = entry.name.match(/^(\d{4})_(.+)\.sql$/);
  if (!match) continue; // 不符合命名的忽略（比如 .DS_Store 之类）
  const seq = parseInt(match[1], 10);
  const tag = `${match[1]}_${match[2]}`; // 例: '0000_init'
  sqlFiles.push({ seq, file: entry.name, tag });
}

if (sqlFiles.length === 0) {
  fail(`drizzle/ 下没有任何 NNNN_*.sql migration 文件`);
}

sqlFiles.sort((a, b) => a.seq - b.seq);

// 检查序号严格从 0 开始、连续、无跳号、无重复
const seenSeqs = new Set();
for (let i = 0; i < sqlFiles.length; i++) {
  const { seq, file } = sqlFiles[i];
  if (seenSeqs.has(seq)) {
    fail(`序号 ${String(seq).padStart(4, '0')} 重复（${file}）`);
  }
  seenSeqs.add(seq);
  if (seq !== i) {
    // 例如 sqlFiles[0].seq 不是 0 → 缺 0000；sqlFiles[2].seq 是 3 → 缺 0002
    if (i === 0) {
      fail(`序号必须从 0000 开始，但首个文件是 ${file}（seq=${seq}）`);
    } else {
      const missing = String(i).padStart(4, '0');
      fail(`序号 ${missing} 缺失（${file} 跳到 ${String(seq).padStart(4, '0')}）`);
    }
  }
}
const maxSeq = sqlFiles[sqlFiles.length - 1].seq;
info(`step 1/6 ok — ${sqlFiles.length} sql file(s), seq 0000..${String(maxSeq).padStart(4, '0')}`);

// ── 2. _journal.json ↔ sql 文件对齐 ────────────────────────────────────────

if (!fs.existsSync(JOURNAL_PATH)) {
  fail(`drizzle/meta/_journal.json 不存在（请跑 pnpm db:generate 重新生成）`);
}

let journal;
try {
  journal = JSON.parse(fs.readFileSync(JOURNAL_PATH, 'utf-8'));
} catch (err) {
  fail(`_journal.json 解析失败：${err instanceof Error ? err.message : String(err)}`);
}

if (!Array.isArray(journal.entries)) {
  fail(`_journal.json 缺少 entries 数组`);
}

/** @type {{ idx: number, tag: string }[]} */
const entries = journal.entries;

if (entries.length !== sqlFiles.length) {
  fail(
    `_journal.json.entries 数量 ${entries.length} ≠ sql 文件数量 ${sqlFiles.length}；` +
      `很可能有 sql 文件手工新增或删除后忘了重新 drizzle-kit generate。`,
  );
}

for (let i = 0; i < entries.length; i++) {
  const entry = entries[i];
  if (typeof entry.idx !== 'number') {
    fail(`_journal.json entries[${i}] 缺少 idx 字段`);
  }
  if (entry.idx !== i) {
    fail(`_journal.json entries[${i}].idx = ${entry.idx}（应为 ${i}）`);
  }
  if (typeof entry.tag !== 'string') {
    fail(`_journal.json entries[${i}] 缺少 tag 字段`);
  }
  const expectedTag = sqlFiles[i].tag;
  if (entry.tag !== expectedTag) {
    fail(
      `_journal.json entries[${i}].tag = "${entry.tag}"，但对应的 sql 文件 tag 是 "${expectedTag}"（${sqlFiles[i].file}）`,
    );
  }
  // drizzle-kit 的命名惯例：每个 tag 都有对应的 <tag>_snapshot.json
  // （实测当前 0000_init 对应 meta/0000_snapshot.json —— snapshot 用 idx 前缀而非完整 tag）
  const snapshotByIdx = path.join(META_DIR, `${String(i).padStart(4, '0')}_snapshot.json`);
  if (!fs.existsSync(snapshotByIdx)) {
    fail(
      `snapshot 文件缺失：${path.relative(DESKTOP_ROOT, snapshotByIdx)}（entries[${i}].tag="${entry.tag}"）`,
    );
  }
}

// snapshot 链 id/prevId 首尾相接检查 —— 防御"手写 sql migration 忘了 drizzle-kit
// generate"导致 prevId 跳过中间 idx 的情况（drizzle-kit check 也会报，但这里给出
// 更清晰的中文错误，且不依赖子进程返回码语义）。
// 约定：0000 的 prevId 是全零 uuid；后续每个 prevId 必须等于上一份的 id。
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
let prevSnapshotId = ZERO_UUID;
for (let i = 0; i < entries.length; i++) {
  const snapshotPath = path.join(META_DIR, `${String(i).padStart(4, '0')}_snapshot.json`);
  let snap;
  try {
    snap = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
  } catch (err) {
    fail(
      `snapshot 解析失败：${path.relative(DESKTOP_ROOT, snapshotPath)} — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof snap.id !== 'string' || typeof snap.prevId !== 'string') {
    fail(`snapshot 缺少 id/prevId 字段：${path.relative(DESKTOP_ROOT, snapshotPath)}`);
  }
  if (snap.prevId !== prevSnapshotId) {
    fail(
      `snapshot 链断裂：${path.relative(DESKTOP_ROOT, snapshotPath)} 的 prevId="${snap.prevId}"` +
        `，应等于上一份（${i === 0 ? '全零 uuid' : `${String(i - 1).padStart(4, '0')}_snapshot.json`}）` +
        `的 id="${prevSnapshotId}"。常见原因：手写了 NNNN_xxx.sql 但忘了跑 pnpm db:generate 补 snapshot。`,
    );
  }
  prevSnapshotId = snap.id;
}
info(`step 2/6 ok — _journal.json entries 与 sql 文件、snapshot 全部对齐，snapshot 链 id/prevId 连续`);

// ── 3. drizzle-kit check（schema drift 检查）──────────────────────────────

info(`step 3/6 running — drizzle-kit check ...`);
// Windows: spawn pnpm 时必须 shell:true 才能找到 .cmd 外壳（pnpm.cmd / pnpm.exe）
const isWin = process.platform === 'win32';
const checkResult = spawnSync(
  isWin ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'drizzle-kit', 'check'],
  {
    cwd: DESKTOP_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
    shell: isWin,
  },
);

if (checkResult.status !== 0) {
  const stderrOut = (checkResult.stderr || '').toString().trim();
  const stdoutOut = (checkResult.stdout || '').toString().trim();
  console.error('[db:validate] drizzle-kit check failed. stdout:');
  console.error(stdoutOut || '(empty)');
  console.error('[db:validate] drizzle-kit check failed. stderr:');
  console.error(stderrOut || '(empty)');
  fail(
    `drizzle-kit check 返回 ${checkResult.status}；通常意味着 schema.ts 改动后忘了跑 pnpm db:generate`,
  );
}
info(`step 3/6 ok — drizzle-kit check 通过（无 schema drift）`);

// ── 4. 冗余的 sql↔snapshot 对齐检查（step 2 已覆盖主要逻辑，这里简单复核）─

// 检查 meta/ 目录中是否存在不属于任何 entries 的 snapshot（孤儿 snapshot）
const metaFiles = fs.readdirSync(META_DIR);
const snapshotFiles = metaFiles.filter((f) => /^\d{4}_snapshot\.json$/.test(f));
if (snapshotFiles.length !== entries.length) {
  fail(
    `meta/ 下的 snapshot 文件数 ${snapshotFiles.length} ≠ journal entries 数 ${entries.length}` +
      `（可能有孤儿 snapshot 或丢失 snapshot，请跑 pnpm db:generate 重新生成）`,
  );
}
info(`step 4/6 ok — ${snapshotFiles.length} snapshot file(s) 与 journal entries 数量一致`);

// ── 5. 配套迁移脚本 drizzle/scripts/*.ts 必须是 CommonJS ─────────────────────
//
// 这些 .ts 不经编译、以 raw 形式随包发出（forge.config.ts extraResource: 'drizzle'），
// 生产 Electron 用 require() 加载：type-stripping 擦掉 `import type` 与类型注解后，按最近
// 的 package.json（无 "type":"module"）当 CommonJS 解析。顶层 ESM `export` / value `import`
// 会让用户端报 `Unexpected token 'export'` / ERR_REQUIRE_ESM——而 dev/vitest 走 import
// 不复现，是只在生产暴露的静默坑（2026-06 由 0040 触发）。约定与 0038 等历史脚本一致：
// `function run(db) {...}` + 末尾 `module.exports = { run }`，依赖一律 `import type`。
const SCRIPTS_DIR = path.join(DRIZZLE_DIR, 'scripts');
const ESM_EXPORT_RE = /^[ \t]*export\b/m; // 顶层 export（含 export function/const/default/{）
const ESM_VALUE_IMPORT_RE = /^[ \t]*import\b(?![ \t]+type\b)/m; // 顶层 import 但非 import type
if (fs.existsSync(SCRIPTS_DIR)) {
  const scriptFiles = fs
    .readdirSync(SCRIPTS_DIR)
    .filter((f) => /^\d{4}_.+\.ts$/.test(f))
    .sort();
  for (const file of scriptFiles) {
    const src = fs.readFileSync(path.join(SCRIPTS_DIR, file), 'utf-8');
    if (ESM_EXPORT_RE.test(src)) {
      fail(
        `drizzle/scripts/${file} 含顶层 ESM \`export\`，但该脚本以 CommonJS require() 加载，` +
          `生产 Electron 会报 Unexpected token 'export'。请改用 \`function run(db){...}\` + ` +
          `\`module.exports = { run }\`（参考 0038_add_session_remote_host_id.ts）。`,
      );
    }
    if (ESM_VALUE_IMPORT_RE.test(src)) {
      fail(
        `drizzle/scripts/${file} 含顶层 value \`import\`（ESM），同样会在生产 require() 时炸。` +
          `依赖请用 \`import type ...\`（type-only，会被擦除）或在 run() 内 \`require()\`。`,
      );
    }
  }
  info(`step 5/6 ok — ${scriptFiles.length} 个配套迁移脚本均为 CommonJS（无顶层 ESM export/import）`);
} else {
  info(`step 5/6 ok — 无 drizzle/scripts/ 目录，跳过`);
}

// ── 6. 旧仓固定基线 / 新仓 main 的 migration runtime identity 冻结 ────────

let freezeResult;
try {
  freezeResult = validateMigrationFreeze(REPO_ROOT);
} catch (err) {
  fail(`migration 冻结校验无法执行：${err instanceof Error ? err.message : String(err)}`);
}

const freezeChecks = [
  {
    label: `migrated baseline (${freezeResult.fixedCheck.sourceCommit.slice(0, 10)})`,
    result: freezeResult.fixedCheck,
  },
];
if (freezeResult.baseline && freezeResult.mainCheck) {
  freezeChecks.push({
    label: `main baseline ${freezeResult.baseline.ref} (${freezeResult.baseline.commit.slice(0, 10)})`,
    result: freezeResult.mainCheck,
  });
}
for (const check of freezeChecks) {
  if (check.result.violations.length === 0) continue;
  const detail = check.result.violations
    .map((violation) => `${violation.path} (${violation.kind})`)
    .join(', ');
  fail(
    `${check.label} 中已有的 migration SQL / companion TS identity 被改写：${detail}。` +
      `已进入 main/发版的 migration runtime 不可增删或修改，请新增 migration 修正。`,
  );
}
const mainSummary = freezeResult.mainCheck
  ? `，main 基线冻结 ${freezeResult.mainCheck.migrationCount} 条 SQL + ` +
    `${freezeResult.mainCheck.runtimeScriptCount} 条 runtime script`
  : '；新仓尚无 main commit，跳过增量 Git 基线';
info(
  `step 6/6 ok — 固定 SHA256 基线冻结 ${freezeResult.fixedCheck.migrationCount} 条 migration SQL + ` +
    `${freezeResult.fixedCheck.runtimeScriptCount} 条 runtime script${mainSummary}`,
);

// ── Done ───────────────────────────────────────────────────────────────────

const maxSeqTag = String(maxSeq).padStart(4, '0');
console.log(
  `✅ migration validation passed: 0000..${maxSeqTag} sql files + journal aligned + no schema drift + scripts CJS-only + historical runtime identities frozen`,
);
process.exit(0);
