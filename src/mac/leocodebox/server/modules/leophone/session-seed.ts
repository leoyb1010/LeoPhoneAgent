import fs from 'node:fs/promises';
import path from 'node:path';

import { expandSessionCwd, sessionCwdAllowed } from './session-workspace.js';

export const SEED_TEXT_MAX = 200_000;

export function sanitizeSeedRel(raw: string): string {
  const parts = raw.trim().replace(/\\/g, '/').replace(/\u0000/g, '').split('/').map((part) => {
    const clean = part.replace(/[^\w.\u4e00-\u9fff-]+/g, '-');
    if (!clean || clean === '.' || clean === '..') return '';
    return clean;
  }).filter(Boolean);
  return parts.join('/') || 'leo-新建.txt';
}

export function clipSeedText(text: string, limit = SEED_TEXT_MAX): string {
  const clean = text.replace(/\u0000/g, '');
  if (clean.length <= limit) return clean;
  throw new Error('这段字太长，落不成文件');
}

export async function seedSessionFile(cwd: string, input: { name?: string; text?: string }): Promise<{ path: string; file: string }> {
  const sessionRoot = await fs.realpath(path.resolve(expandSessionCwd(cwd)));
  if (!sessionCwdAllowed(sessionRoot)) throw new Error('这个目录不能建文件');
  const rel = sanitizeSeedRel(input.name ?? '');
  const abs = path.resolve(sessionRoot, rel);
  const check = path.relative(sessionRoot, abs);
  if (!check || check.startsWith('..') || path.isAbsolute(check)) throw new Error('只能建在这个会话目录里');
  const exists = await fs.stat(abs).catch(() => null);
  if (exists) throw new Error('已经有这个文件');
  const text = clipSeedText(String(input.text ?? ''));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text, 'utf8');
  return { path: abs, file: check.split(path.sep).join('/') };
}
