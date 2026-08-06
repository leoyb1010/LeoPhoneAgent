/**
 * agents-md converter: CLAUDE.md ↔ AGENTS.md
 *
 * 二次安全检查：写入前再次确认 target 缺失（detector → user 操作期间可能变化）。
 * target 已存在 → 返回 'skipped' 而非 'failed'。
 */

import fs from 'node:fs/promises';

import { isMissingOrEmptyTextFile } from '../detector.js';
import type { MigrationItem, MigrationStepStatus } from '../types.js';

import { rewriteTerms } from './term-rewrite.js';

export interface ConvertOutcome {
  status: MigrationStepStatus;
  detail?: string;
}

export async function convertAgentsMd(item: MigrationItem): Promise<ConvertOutcome> {
  // 二次校验：弹窗期间用户可能手动建了文件
  const stillMissing = await isMissingOrEmptyTextFile(item.target);
  if (!stillMissing) {
    return { status: 'skipped', detail: '目标已存在' };
  }

  let raw: string;
  try {
    raw = await fs.readFile(item.source, 'utf8');
  } catch (err) {
    return {
      status: 'failed',
      detail: `读取源失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const rewritten = rewriteTerms(raw, item.direction);

  try {
    // wx flag = 仅在文件不存在时创建。用 atomic check 兜底，避免覆盖。
    await fs.writeFile(item.target, rewritten, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e && e.code === 'EEXIST') {
      return { status: 'skipped', detail: '目标已存在' };
    }
    return {
      status: 'failed',
      detail: `写入失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { status: 'success' };
}
