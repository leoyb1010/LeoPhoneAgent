/**
 * legacyDeadDirs.ts — 冻结历史兼容层的死目录清退。
 * ---------------------------------------------------------------------------
 * `userData/cc-agent/` 下有三个**现行代码零引用**的死目录(2026-07 实地盘点
 * 约 40MB;目录改名后旧目录永久滞留的历史证据):
 *   - @cindy/image-media(art 图片老仓改名前身)
 *   - mivo-media / mivo(mivo 集成早期目录,现行写 lizi-mivo-models 等)
 *
 * 这是对冻结历史兼容层的**唯一**允许删除操作,门槛按三条全满足:
 *   1. 现行代码零引用 —— 2026-07-12 全仓 grep 核验;
 *   2. 线上正式版代码零引用 —— 同一结论(dev 与 release 同源 main);
 *   3. 目录内所有文件 mtime > 30 天 —— 本模块运行时逐文件核验,有一个新
 *      文件整个目录就不合格(说明"零引用"结论过期了,宁可不删)。
 * 且一律先报数(scan)、用户在存储卡片上确认后才 clean,clean 前重新核验。
 *
 * 除这三个名字外不接受任何目录参数——绝不给"删 cc-agent 任意子目录"留口。
 */

import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';

import { createLogger } from '../logger';

const log = createLogger('cindy-media-dead-dirs');

/** 唯一允许清退的目录名单(见文件头三条门槛)。 */
export const DEAD_DIR_NAMES = ['@cindy/image-media', 'mivo-media', 'mivo'] as const;
export type DeadDirName = (typeof DEAD_DIR_NAMES)[number];

/** 全目录文件都要老于此才可清退(设计 §4 第三条)。 */
export const DEAD_DIR_MIN_STALE_MS = 30 * 24 * 60 * 60 * 1000;

function legacyRoot(): string {
  return path.join(app.getPath('userData'), 'cc-agent');
}

export interface DeadDirStatus {
  name: DeadDirName;
  exists: boolean;
  bytes: number;
  fileCount: number;
  /** 目录内最新文件的 mtime(空目录/不存在为 0)。 */
  newestMtimeMs: number;
  /** 三条门槛全满足,可列入清退候选。 */
  eligible: boolean;
}

async function walkDir(
  dir: string,
  acc: { bytes: number; fileCount: number; newestMtimeMs: number },
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkDir(abs, acc);
    } else if (entry.isFile()) {
      try {
        const st = await fs.stat(abs);
        acc.bytes += st.size;
        acc.fileCount++;
        if (st.mtimeMs > acc.newestMtimeMs) acc.newestMtimeMs = st.mtimeMs;
      } catch {
        // 扫描间隙消失:忽略。
      }
    }
  }
}

async function scanOne(rootDir: string, name: DeadDirName, now: number): Promise<DeadDirStatus> {
  const dir = path.join(rootDir, name);
  const exists = await fs.access(dir).then(
    () => true,
    () => false,
  );
  if (!exists) {
    return { name, exists: false, bytes: 0, fileCount: 0, newestMtimeMs: 0, eligible: false };
  }
  const acc = { bytes: 0, fileCount: 0, newestMtimeMs: 0 };
  await walkDir(dir, acc);
  // 空目录(fileCount=0)也允许清退——壳本身就是滞留物。
  const stale = acc.fileCount === 0 || now - acc.newestMtimeMs > DEAD_DIR_MIN_STALE_MS;
  return { name, exists: true, ...acc, eligible: stale };
}

/** 报数:三个死目录的占用与清退资格。rootDir 可注入(测试);生产走 userData/cc-agent。 */
export async function scanDeadDirs(rootDir: string = legacyRoot()): Promise<DeadDirStatus[]> {
  const now = Date.now();
  return Promise.all(DEAD_DIR_NAMES.map((name) => scanOne(rootDir, name, now)));
}

export interface DeadDirCleanResult {
  removed: DeadDirName[];
  /** 名字不在名单 / 已不存在 / 复验不合格(有新文件)而拒绝的。 */
  skipped: string[];
  freedBytes: number;
}

/**
 * 清退:只认名单内目录,删除前重新核验资格(报数与确认之间可能有新写入——
 * 理论上不该有,但"零引用"结论一旦过期宁可拒绝)。
 */
export async function cleanDeadDirs(
  names: string[],
  rootDir: string = legacyRoot(),
): Promise<DeadDirCleanResult> {
  const result: DeadDirCleanResult = { removed: [], skipped: [], freedBytes: 0 };
  const now = Date.now();
  for (const raw of names) {
    const name = DEAD_DIR_NAMES.find((n) => n === raw);
    if (!name) {
      result.skipped.push(raw);
      continue;
    }
    const status = await scanOne(rootDir, name, now);
    if (!status.exists || !status.eligible) {
      result.skipped.push(name);
      continue;
    }
    try {
      await fs.rm(path.join(rootDir, name), { recursive: true, force: true });
      result.removed.push(name);
      result.freedBytes += status.bytes;
      log.info('removed legacy dead dir', { name, bytes: status.bytes, files: status.fileCount });
    } catch (err) {
      result.skipped.push(name);
      log.warn('failed to remove legacy dead dir', {
        name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

/** 历史 cc-agent 目录总占用(存储卡片"老版本数据(只读)"一行展示用)。 */
export async function getLegacyRootUsage(
  rootDir: string = legacyRoot(),
): Promise<{ bytes: number; fileCount: number }> {
  const acc = { bytes: 0, fileCount: 0, newestMtimeMs: 0 };
  await walkDir(rootDir, acc);
  return { bytes: acc.bytes, fileCount: acc.fileCount };
}
