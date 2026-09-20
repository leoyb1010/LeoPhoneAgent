import fs from 'node:fs/promises';
import path from 'node:path';

import { expandSessionCwd, sessionCwdAllowed } from './session-workspace.js';

function trashRel(raw: string): string {
  return raw.trim().replace(/\\/g, '/').replace(/\u0000/g, '');
}

export async function trashSessionFile(cwd: string, file: string): Promise<{ file: string }> {
  const sessionRoot = await fs.realpath(path.resolve(expandSessionCwd(cwd)));
  if (!sessionCwdAllowed(sessionRoot)) throw new Error('这个目录不能扔文件');
  const rel = trashRel(file);
  if (!rel) throw new Error('先点开一份文件');
  if (rel.startsWith('/') || rel.split('/').includes('..') || rel.split('/').includes('.')) {
    throw new Error('只能扔这个会话目录里的文件');
  }
  if (rel === '.git' || rel.startsWith('.git/')) throw new Error('不能扔 git 自己');
  const abs = path.resolve(sessionRoot, rel);
  const check = path.relative(sessionRoot, abs);
  if (!check || check.startsWith('..') || path.isAbsolute(check)) throw new Error('只能扔这个会话目录里的文件');
  const stat = await fs.lstat(abs).catch(() => null);
  if (!stat) throw new Error('没有这份文件');
  if (stat.isDirectory()) throw new Error('这是文件夹，只扔文件');
  if (stat.isSymbolicLink()) throw new Error('不跟符号链接走');
  await fs.unlink(abs);
  return { file: check.split(path.sep).join('/') };
}
