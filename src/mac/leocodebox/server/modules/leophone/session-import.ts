import fs from 'node:fs/promises';
import path from 'node:path';

import { expandSessionCwd, sessionCwdAllowed } from './session-workspace.js';

export const IMPORT_MARKDOWN_MAX = 80_000;

export function looksLikeTalkExport(name: string): boolean {
  return /^leo-对话.*\.md$/iu.test(name);
}

export function sanitizeImportName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || /[/\\]/.test(trimmed) || trimmed.includes('..')) throw new Error('只能接回记下的对话');
  if (!looksLikeTalkExport(trimmed)) throw new Error('只能接回记下的对话');
  return trimmed;
}

async function newestTalkExport(root: string): Promise<string> {
  const names = await fs.readdir(root);
  const found: Array<{ name: string; mtime: number }> = [];
  for (const name of names) {
    if (!looksLikeTalkExport(name)) continue;
    const abs = path.join(root, name);
    const stat = await fs.lstat(abs).catch(() => null);
    if (!stat?.isFile()) continue;
    found.push({ name, mtime: stat.mtimeMs });
  }
  found.sort((a, b) => b.mtime - a.mtime);
  if (!found[0]) throw new Error('会话目录里没有记下的对话');
  return found[0].name;
}

export async function readSessionImport(cwd: string, name?: string): Promise<{ name: string; markdown: string }> {
  const root = await fs.realpath(path.resolve(expandSessionCwd(cwd)));
  if (!sessionCwdAllowed(root)) throw new Error('这个目录不能接回对话');
  const rel = name?.trim() ? sanitizeImportName(name) : await newestTalkExport(root);
  const dest = path.resolve(root, rel);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (dest === root || !dest.startsWith(prefix)) throw new Error('文件名不合法');
  const stat = await fs.lstat(dest).catch(() => null);
  if (!stat?.isFile()) throw new Error('会话目录里没有这份记下的对话');
  const markdown = (await fs.readFile(dest, 'utf8')).replace(/\u0000/g, '').trim();
  if (!markdown) throw new Error('这份记下的对话是空的');
  return {
    name: path.basename(dest),
    markdown: markdown.length <= IMPORT_MARKDOWN_MAX ? markdown : `${markdown.slice(0, IMPORT_MARKDOWN_MAX)}\n\n…(后面还有 ${markdown.length - IMPORT_MARKDOWN_MAX} 字)`,
  };
}
