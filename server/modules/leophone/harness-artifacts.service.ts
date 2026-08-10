import fs from 'node:fs';
import path from 'node:path';

import type { HarnessSession } from './harness-session.service.js';

/**
 * [T-leophone-artifacts] 会话产物:CLI 在工作目录里生成/改动的文件,
 * 让手机能列出来并单独取回。
 *
 * 两条硬约束决定了实现形态:
 * 1. 中继的 handleHttp 只转发 JSON,二进制走不了 —— 所以清单是 JSON,
 *    内容单独一个端点走流式,由手机的 background URLSession 直接拉。
 * 2. 路径必须锁死在会话 cwd 内。CLI 的工具预览里出现过什么路径不作数,
 *    读之前一律 realpath 再判前缀,防止 ../ 穿越把 ~/.ssh 读走。
 *
 * 产物来源不是"猜",而是从事件日志里 CLI 自己报告的写入/修改路径提取。
 */

export type ArtifactInfo = {
  name: string;
  size: number;
  modified_at: number;
  mime: string;
};

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.zip': 'application/zip',
};

const MAX_ARTIFACTS = 50;
/** 超过这个大小不进清单——手机上没人要通过中继拉一个 200MB 的构建产物。 */
const MAX_SIZE = 25 * 1024 * 1024;

function mimeFor(name: string): string {
  return MIME_BY_EXT[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

/** 会话工作目录的真实路径;解析不了就返回 null(不猜)。 */
function sessionRoot(session: HarnessSession): string | null {
  const cwd = (session.summary() as Record<string, unknown>).cwd;
  if (typeof cwd !== 'string' || !cwd) return null;
  try {
    return fs.realpathSync(cwd);
  } catch {
    return null;
  }
}

/** 候选路径:从事件日志里 CLI 报告过的文件路径。 */
function candidatePaths(session: HarnessSession): string[] {
  const out = new Set<string>();
  for (const event of session.replay(0)) {
    if (event.event !== 'tool.started' && event.event !== 'tool.completed') continue;
    const preview = typeof event.preview === 'string' ? event.preview : '';
    const matches = preview.match(/(?:[\w.~/-]*\/)?[\w.-]+\.[A-Za-z0-9]{1,8}/g);
    if (!matches) continue;
    for (const m of matches) {
      out.add(m);
      if (out.size > 400) return [...out];
    }
  }
  return [...out];
}

/** 把候选解析成"确实存在、确实在 cwd 内、确实是普通文件"的产物。 */
export function listArtifacts(session: HarnessSession): ArtifactInfo[] {
  const root = sessionRoot(session);
  if (!root) return [];
  const seen = new Map<string, ArtifactInfo>();

  for (const candidate of candidatePaths(session)) {
    if (seen.size >= MAX_ARTIFACTS) break;
    const abs = path.isAbsolute(candidate) ? candidate : path.join(root, candidate);
    let real: string;
    let stat: fs.Stats;
    try {
      real = fs.realpathSync(abs);
      stat = fs.statSync(real);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > MAX_SIZE) continue;
    // 锁死在会话工作目录内
    if (real !== root && !real.startsWith(root + path.sep)) continue;
    const name = path.relative(root, real);
    if (!name || name.startsWith('..')) continue;
    if (seen.has(name)) continue;
    seen.set(name, {
      name,
      size: stat.size,
      modified_at: Math.floor(stat.mtimeMs / 1000),
      mime: mimeFor(name),
    });
  }

  return [...seen.values()].sort((a, b) => b.modified_at - a.modified_at);
}

export type ArtifactFile = ArtifactInfo & { path: string };

/** 按清单里的相对名取一个产物;越界/不存在返回 null。 */
export function readArtifact(session: HarnessSession, name: string): ArtifactFile | null {
  const root = sessionRoot(session);
  if (!root) return null;
  const decoded = decodeURIComponent(name);
  if (path.isAbsolute(decoded)) return null;
  const abs = path.join(root, decoded);
  let real: string;
  let stat: fs.Stats;
  try {
    real = fs.realpathSync(abs);
    stat = fs.statSync(real);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (real !== root && !real.startsWith(root + path.sep)) return null;
  if (stat.size > MAX_SIZE) return null;
  const rel = path.relative(root, real);
  return {
    name: rel,
    size: stat.size,
    modified_at: Math.floor(stat.mtimeMs / 1000),
    mime: mimeFor(rel),
    path: real,
  };
}
