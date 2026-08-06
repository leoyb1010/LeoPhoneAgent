/**
 * skillhub/folderHash.ts — 跨平台 folderHash 算法 (F-pub-4)
 *
 * 算法：
 *   1. 递归遍历目录，排除明确高风险 / 平台噪声路径
 *   2. 每个常规文件：计算 POSIX 相对路径 + 文件内容 sha256（流式，不读入内存字符串）
 *   3. 拼成 "relPath:fileHash" 行，字典序排序后拼接换行
 *   4. 再 sha256 整体 → 最终 folderHash
 *
 * 跨平台一致性保证：
 *   - path.relative() 结果通过 split(path.sep).join('/') 归一化为 POSIX 正斜杠
 *   - fs.createReadStream() 以二进制读取，不做任何行尾转换
 *   - 以上确保 Win/macOS/Linux 对同内容目录产出完全相同的 hash
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isIgnoredSkillPackagePath } from './packageIgnore';

// ── sha256 辅助 ──────────────────────────────────────────────────────────────

function streamSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

// ── walk 递归 ────────────────────────────────────────────────────────────────

async function walk(dir: string, rootDir: string, lines: string[]): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    // 无法读取目录（权限不足等）时跳过
    return;
  }

  for (const e of entries) {
    const fullPath = path.join(dir, e.name);
    const rel = path.relative(rootDir, fullPath).split(path.sep).join('/');
    if (isIgnoredSkillPackagePath(rel)) continue;

    if (e.isDirectory()) {
      await walk(fullPath, rootDir, lines);
      continue;
    }

    if (!e.isFile()) continue; // 跳过 symlink / socket

    const contentHash = await streamSha256(fullPath);
    lines.push(`${rel}:${contentHash}`);
  }
}

// ── 公开 API ─────────────────────────────────────────────────────────────────

export interface FolderHashEntry {
  /** POSIX 相对路径(相对 absolutePath) */
  path: string;
  /** 文件内容 sha256 hex */
  sha256: string;
}

export interface FolderHashDetailed {
  hash: string;
  manifest: FolderHashEntry[];
}

/**
 * 详细版:同时返回 hash + 参与计算的文件清单。
 * 用于 dirty 排查——把清单透传到 renderer 直接列出来,避免 main/renderer 控制台
 * 来回切。
 */
export async function computeFolderHashDetailed(
  absolutePath: string,
): Promise<FolderHashDetailed> {
  const lines: string[] = [];
  await walk(absolutePath, absolutePath, lines);
  lines.sort(); // 字典序,确保顺序一致
  const combined = lines.join('\n');
  const finalHash = crypto.createHash('sha256').update(combined).digest('hex');

  const manifest: FolderHashEntry[] = lines.map((l) => {
    // 行格式:"relPath:fileHash" — 文件名理论上不含 ':',但 sha256 固定 64 位,
    // 从右数 65 字符切开是最稳的拆分方式。
    const colonIdx = l.length - 65;
    return { path: l.slice(0, colonIdx), sha256: l.slice(colonIdx + 1) };
  });

  return { hash: finalHash, manifest };
}

export async function computeFolderHash(absolutePath: string): Promise<string> {
  const { hash } = await computeFolderHashDetailed(absolutePath);
  return hash;
}
