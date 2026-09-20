import fs from 'node:fs/promises';
import path from 'node:path';

import { expandSessionCwd, sessionCwdAllowed } from './session-workspace.js';

function fileRel(raw: string): string {
  return raw.trim().replace(/\\/g, '/').replace(/\u0000/g, '');
}

export function sanitizeMoveFolder(raw: string): string {
  const parts = raw.trim().replace(/\\/g, '/').replace(/\u0000/g, '').split('/').map((part) => {
    const clean = part.replace(/[^\w.\u4e00-\u9fff-]+/g, '-');
    if (!clean || clean === '.' || clean === '..') return '';
    return clean;
  }).filter(Boolean);
  return parts.join('/');
}

export function moveDestRel(file: string, destFolder = ''): string {
  const rel = fileRel(file);
  const base = rel.split('/').filter(Boolean).pop() || 'leo-文件';
  const folder = sanitizeMoveFolder(destFolder);
  return folder ? `${folder}/${base}` : base;
}

function assertInside(sessionRoot: string, rel: string, verb: string): string {
  if (!rel) throw new Error(verb === 'from' ? '先点开一份文件' : '写一个文件夹');
  if (rel.startsWith('/') || rel.split('/').includes('..') || rel.split('/').includes('.')) {
    throw new Error('只能挪在这个会话目录里');
  }
  if (rel === '.git' || rel.startsWith('.git/') || rel.split('/').includes('.git')) {
    throw new Error('不能动 git 自己');
  }
  const abs = path.resolve(sessionRoot, rel);
  const check = path.relative(sessionRoot, abs);
  if (!check || check.startsWith('..') || path.isAbsolute(check)) throw new Error('只能挪在这个会话目录里');
  return check.split(path.sep).join('/');
}

export async function moveSessionFile(cwd: string, file: string, destFolder?: string): Promise<{ from: string; file: string }> {
  const sessionRoot = await fs.realpath(path.resolve(expandSessionCwd(cwd)));
  if (!sessionCwdAllowed(sessionRoot)) throw new Error('这个目录不能挪文件');
  const from = assertInside(sessionRoot, fileRel(file), 'from');
  const destRel = assertInside(sessionRoot, moveDestRel(from, destFolder ?? ''), 'to');
  if (destRel === from) throw new Error('已经在这儿了');
  const src = path.join(sessionRoot, from);
  const dest = path.join(sessionRoot, destRel);
  const stat = await fs.lstat(src).catch(() => null);
  if (!stat) throw new Error('没有这份文件');
  if (stat.isDirectory()) throw new Error('这是文件夹，只挪文件');
  if (stat.isSymbolicLink()) throw new Error('不跟符号链接走');
  const exists = await fs.lstat(dest).catch(() => null);
  if (exists) throw new Error('已经有这个名字');
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.rename(src, dest);
  return { from, file: destRel };
}
