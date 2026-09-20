import fs from 'node:fs/promises';
import path from 'node:path';

import { expandSessionCwd, sessionCwdAllowed } from './session-workspace.js';

export const EXPORT_MARKDOWN_MAX = 800_000;

export function sanitizeExportName(raw: string): string {
  const base = raw.replace(/^.*[/\\]/, '').replace(/[^\w.\u4e00-\u9fff-]+/g, '-').replace(/^\.+/, '').replace(/-+$/g, '').slice(0, 80);
  const named = base || 'leo-对话.md';
  return named.toLowerCase().endsWith('.md') ? named : `${named}.md`;
}

export function clipExportMarkdown(text: string, limit = EXPORT_MARKDOWN_MAX): string {
  const clean = text.replace(/\u0000/g, '').trim();
  if (!clean) throw new Error('还没有可记下的对话');
  if (clean.length <= limit) return `${clean}\n`;
  return `${clean.slice(0, limit)}\n\n…(后面还有 ${clean.length - limit} 字)\n`;
}

function resolveExportDest(cwd: string, name: string): string {
  const root = path.resolve(expandSessionCwd(cwd));
  if (!sessionCwdAllowed(root)) throw new Error('这个目录不能记下对话');
  const dest = path.resolve(root, sanitizeExportName(name));
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (dest === root || !dest.startsWith(prefix)) throw new Error('文件名不合法');
  return dest;
}

export async function writeSessionExport(cwd: string, input: { name: string; markdown: string }): Promise<{ path: string; name: string }> {
  const markdown = clipExportMarkdown(input.markdown);
  const dest = resolveExportDest(cwd, input.name);
  await fs.writeFile(dest, markdown, 'utf8');
  return { path: dest, name: path.basename(dest) };
}
