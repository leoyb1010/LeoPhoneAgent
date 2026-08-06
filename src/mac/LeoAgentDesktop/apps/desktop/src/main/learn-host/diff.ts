/**
 * diff.ts —— Learn 审查 diff 的补充规则。
 *
 * 通用 skillhub diff 会跳过 package-ignored 路径;Learn apply 是整目录替换,
 * 所以旧目录中被忽略的路径仍会被删除。这里用 removed 变更补回旧侧删除,
 * 同时在目录级短路 node_modules/.venv 等大目录,避免为每个子文件生成 diff。
 */

import fs from 'node:fs';
import path from 'node:path';

import type { FileChange } from '../skillhub/snapshot';
import { isExcludedProposalPath } from './stagingValidation.pure';

async function excludedOldSideRemoval(oldDir: string, rel: string): Promise<FileChange | null> {
  const oldPath = path.join(oldDir, rel.split('/').join(path.sep));
  const oldStat = await fs.promises.lstat(oldPath).catch(() => null);
  if (!oldStat) return null;
  // 一律 path/size-only(isBinary 摘要形态,不读内容):这些路径正是 ignore
  // 规则定性为敏感/无关的(.env/.npmrc/secrets 等),把全文送进 diff 面板
  // (跨 IPC 进 renderer)等于把敏感内容主动泄漏给审查界面(Codex review)。
  // 用户只需要知道"这个旧文件会被删",不需要看到它的内容。
  return {
    path: rel,
    kind: 'removed',
    isBinary: true,
    oldContent: '',
    newContent: '',
    oldSize: oldStat.size,
    newSize: 0,
  };
}

export async function computeExcludedOldSideRemovals(oldDir: string): Promise<FileChange[]> {
  const removals: FileChange[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = path.relative(oldDir, full).split(path.sep).join('/');
      if (isExcludedProposalPath(rel)) {
        const removal = await excludedOldSideRemoval(oldDir, rel);
        if (removal) removals.push(removal);
        continue;
      }
      if (e.isDirectory()) {
        await walk(full);
        continue;
      }
      // 非常规条目(symlink/socket 等):computeTwoDirDiff 的 listFiles 只收
      // regular file,会把它们静默丢掉 —— 但整目录替换同样会删掉它们,必须
      // 以摘要形态出现在 removed 列表里(Codex review)。
      if (!e.isFile()) {
        const removal = await excludedOldSideRemoval(oldDir, rel);
        if (removal) removals.push(removal);
      }
    }
  }
  await walk(oldDir);
  removals.sort((a, b) => a.path.localeCompare(b.path));
  return removals;
}
