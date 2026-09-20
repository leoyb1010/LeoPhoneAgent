import fs from 'node:fs/promises';
import path from 'node:path';

import { expandSessionCwd, sessionCwdAllowed } from './session-workspace.js';

function fileRel(raw: string): string {
  return raw.trim().replace(/\\/g, '/').replace(/\u0000/g, '');
}

function assertInside(sessionRoot: string, rel: string, verb: string): string {
  if (!rel) throw new Error(verb === 'from' ? '先点开一份文件' : '写一个副本名字');
  if (rel.startsWith('/') || rel.split('/').includes('..') || rel.split('/').includes('.')) {
    throw new Error('只能复制在这个会话目录里');
  }
  if (rel === '.git' || rel.startsWith('.git/')) throw new Error('不能动 git 自己');
  const abs = path.resolve(sessionRoot, rel);
  const check = path.relative(sessionRoot, abs);
  if (!check || check.startsWith('..') || path.isAbsolute(check)) throw new Error('只能复制在这个会话目录里');
  return check.split(path.sep).join('/');
}

export function nextDuplicateName(file: string): string {
  const rel = fileRel(file);
  const slash = rel.lastIndexOf('/');
  const dir = slash >= 0 ? rel.slice(0, slash + 1) : '';
  const base = slash >= 0 ? rel.slice(slash + 1) : rel;
  const dot = base.lastIndexOf('.');
  const stem = (dot > 0 ? base.slice(0, dot) : base).replace(/-副本(?:-\d+)?$/, '') || 'leo-文件';
  const ext = dot > 0 ? base.slice(dot) : '';
  return `${dir}${stem}-副本${ext}`;
}

export async function duplicateSessionFile(cwd: string, file: string, name?: string): Promise<{ file: string; from: string }> {
  const sessionRoot = await fs.realpath(path.resolve(expandSessionCwd(cwd)));
  if (!sessionCwdAllowed(sessionRoot)) throw new Error('这个目录不能复制文件');
  const from = assertInside(sessionRoot, fileRel(file), 'from');
  const src = path.join(sessionRoot, from);
  const stat = await fs.lstat(src).catch(() => null);
  if (!stat) throw new Error('没有这份文件');
  if (stat.isDirectory()) throw new Error('这是文件夹，只复制文件');
  if (stat.isSymbolicLink()) throw new Error('不跟符号链接走');

  let destRel = fileRel(name ?? '');
  if (!destRel) destRel = nextDuplicateName(from);
  destRel = assertInside(sessionRoot, destRel, 'to');
  if (destRel === from) throw new Error('副本不能盖住原文件');

  const exists = (rel: string) => fs.stat(path.join(sessionRoot, rel)).then(() => true, () => false);
  if (await exists(destRel)) {
    const seed = nextDuplicateName(from);
    let found = '';
    for (let i = 2; i <= 20; i += 1) {
      const candidate = assertInside(sessionRoot, seed.replace(/-副本(?:-\d+)?(\.[^./]+)?$/, `-副本-${i}$1`), 'to');
      if (candidate === from) continue;
      if (!(await exists(candidate))) { found = candidate; break; }
    }
    if (!found) throw new Error('已经有这么多副本了');
    destRel = found;
  }
  await fs.mkdir(path.dirname(path.join(sessionRoot, destRel)), { recursive: true });
  await fs.copyFile(src, path.join(sessionRoot, destRel));
  return { from, file: destRel };
}
