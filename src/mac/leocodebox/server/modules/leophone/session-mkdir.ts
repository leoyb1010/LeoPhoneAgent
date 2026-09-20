import fs from 'node:fs/promises';
import path from 'node:path';

import { expandSessionCwd, sessionCwdAllowed } from './session-workspace.js';

export function sanitizeFolderRel(raw: string): string {
  const parts = raw.trim().replace(/\\/g, '/').replace(/\u0000/g, '').split('/').map((part) => {
    const clean = part.replace(/[^\w.\u4e00-\u9fff-]+/g, '-');
    if (!clean || clean === '.' || clean === '..') return '';
    return clean;
  }).filter(Boolean);
  return parts.join('/') || 'leo-新建';
}

function assertInside(sessionRoot: string, rel: string): string {
  if (!rel) throw new Error('写一个文件夹名字');
  if (rel.startsWith('/') || rel.split('/').includes('..') || rel.split('/').includes('.')) {
    throw new Error('只能建在这个会话目录里');
  }
  if (rel === '.git' || rel.startsWith('.git/') || rel.split('/').includes('.git')) {
    throw new Error('不能动 git 自己');
  }
  const abs = path.resolve(sessionRoot, rel);
  const check = path.relative(sessionRoot, abs);
  if (!check || check.startsWith('..') || path.isAbsolute(check)) throw new Error('只能建在这个会话目录里');
  return check.split(path.sep).join('/');
}

export async function mkdirSessionFolder(cwd: string, name?: string): Promise<{ path: string; folder: string }> {
  const sessionRoot = await fs.realpath(path.resolve(expandSessionCwd(cwd)));
  if (!sessionCwdAllowed(sessionRoot)) throw new Error('这个目录不能建文件夹');
  const rel = assertInside(sessionRoot, sanitizeFolderRel(name ?? ''));
  const abs = path.join(sessionRoot, rel);
  const exists = await fs.lstat(abs).catch(() => null);
  if (exists) throw new Error(exists.isDirectory() ? '已经有这个文件夹' : '已经有这个名字');
  await fs.mkdir(abs, { recursive: true });
  return { path: abs, folder: rel };
}
