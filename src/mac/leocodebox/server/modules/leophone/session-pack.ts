import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { expandSessionCwd, sessionCwdAllowed } from './session-workspace.js';

export const PACK_FILE_MAX = 40;

function run(cwd: string, command: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export function sanitizePackName(raw: string): string {
  const base = path.basename(raw.trim() || 'leo-改动.zip').replace(/\u0000/g, '');
  const safe = base.replace(/[^\w.\u4e00-\u9fff-]+/g, '-').replace(/^\.+/, '') || 'leo-改动.zip';
  return safe.toLowerCase().endsWith('.zip') ? safe : `${safe}.zip`;
}

function resolvePackFile(root: string, file: string): string {
  const trimmed = file.trim();
  if (!trimmed || trimmed.startsWith('-')) throw new Error('文件名不合法');
  const abs = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(root, trimmed);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('只能带走这个会话目录里的文件');
  return rel.split(path.sep).join('/');
}

export async function listDirtySessionFiles(cwd: string): Promise<string[]> {
  const sessionRoot = await fs.realpath(path.resolve(expandSessionCwd(cwd)));
  if (!sessionCwdAllowed(sessionRoot)) throw new Error('这个目录不能打包');
  const top = await run(sessionRoot, 'git', ['rev-parse', '--show-toplevel']);
  if (top.code !== 0 || !top.stdout.trim()) throw new Error('这个目录没有 git，看不到这次改动');
  const root = await fs.realpath(top.stdout.trim());
  const changed = await run(root, 'git', ['-c', 'core.pager=', 'diff', '--name-only', 'HEAD']);
  const extra = await run(root, 'git', ['ls-files', '--others', '--exclude-standard']);
  const names = `${changed.stdout}\n${extra.stdout}`.split('\n').map((line) => line.trim()).filter(Boolean);
  const out: string[] = [];
  for (const name of names) {
    const abs = path.resolve(root, name);
    const relSession = path.relative(sessionRoot, abs);
    if (!relSession || relSession.startsWith('..') || path.isAbsolute(relSession)) continue;
    const rel = relSession.split(path.sep).join('/');
    if (/^leo-改动.*\.zip$/i.test(path.basename(rel))) continue;
    if (!out.includes(rel)) out.push(rel);
  }
  return out;
}

export async function packSessionChanges(cwd: string, input: { name?: string; files?: readonly string[] }): Promise<{ path: string; name: string; files: string[] }> {
  const sessionRoot = await fs.realpath(path.resolve(expandSessionCwd(cwd)));
  if (!sessionCwdAllowed(sessionRoot)) throw new Error('这个目录不能打包');
  const requested = (input.files ?? []).map((file) => file.trim()).filter(Boolean);
  const files = requested.length ? requested.map((file) => resolvePackFile(sessionRoot, file)) : await listDirtySessionFiles(cwd);
  const unique = [...new Set(files)].filter((file) => !/^leo-改动.*\.zip$/i.test(path.basename(file)));
  if (!unique.length) throw new Error('还没有可带走的改动');
  if (unique.length > PACK_FILE_MAX) throw new Error(`一次最多带走 ${PACK_FILE_MAX} 个文件`);
  const existing: string[] = [];
  for (const file of unique) {
    try {
      await fs.access(path.join(sessionRoot, file));
      existing.push(file);
    } catch {
      // deleted files have nothing to take
    }
  }
  if (!existing.length) throw new Error('还没有可带走的改动');
  const name = sanitizePackName(input.name ?? 'leo-改动.zip');
  const dest = path.join(sessionRoot, name);
  const zipped = await run(sessionRoot, '/usr/bin/zip', ['-q', '-X', dest, '--', ...existing]);
  if (zipped.code !== 0) throw new Error(zipped.stderr.replace(/\s+/g, ' ').trim() || '打不成一份');
  return { path: dest, name, files: existing };
}
