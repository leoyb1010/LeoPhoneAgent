import fs from 'node:fs/promises';
import path from 'node:path';

import { expandSessionCwd, sessionCwdAllowed } from './session-workspace.js';

export const DROP_MAX_BYTES = 12 * 1024 * 1024;

export function sanitizeDropName(raw: string, fallback = 'dropped.bin'): string {
  const base = raw.replace(/^.*[/\\]/, '').replace(/[^\w.\u4e00-\u9fff-]+/g, '-').replace(/^\.+/, '').slice(0, 80);
  return base || fallback;
}

export function resolveDropDest(cwd: string, name: string): string {
  const root = path.resolve(expandSessionCwd(cwd));
  if (!sessionCwdAllowed(root)) throw new Error('这个目录不能放文件');
  const dest = path.resolve(root, sanitizeDropName(name));
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (dest !== root && !dest.startsWith(prefix)) throw new Error('文件名不合法');
  if (dest === root) throw new Error('文件名不合法');
  return dest;
}

export async function uniqueDropDest(dest: string): Promise<string> {
  const exists = await fs.stat(dest).catch(() => null);
  if (!exists) return dest;
  const ext = path.extname(dest);
  const stem = ext ? dest.slice(0, -ext.length) : dest;
  for (let i = 2; i < 50; i += 1) {
    const next = `${stem}-${i}${ext}`;
    if (!(await fs.stat(next).catch(() => null))) return next;
  }
  throw new Error('同名文件太多');
}

export async function writeDroppedBytes(cwd: string, name: string, bytes: Buffer): Promise<{ path: string; name: string }> {
  if (!bytes.length) throw new Error('空文件');
  if (bytes.length > DROP_MAX_BYTES) throw new Error('文件太大');
  const dest = await uniqueDropDest(resolveDropDest(cwd, name));
  await fs.writeFile(dest, bytes);
  return { path: dest, name: path.basename(dest) };
}

export async function copyDroppedFile(cwd: string, fromPath: string): Promise<{ path: string; name: string }> {
  const src = path.resolve(fromPath);
  if (!sessionCwdAllowed(src)) throw new Error('这个文件不能放入会话');
  const info = await fs.stat(src).catch(() => null);
  if (!info || !info.isFile()) throw new Error('只能放入普通文件');
  if (info.size > DROP_MAX_BYTES) throw new Error('文件太大');
  const dest = await uniqueDropDest(resolveDropDest(cwd, path.basename(src)));
  await fs.copyFile(src, dest);
  return { path: dest, name: path.basename(dest) };
}
