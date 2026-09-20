import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { expandSessionCwd, sessionCwdAllowed } from './session-workspace.js';

export type FolderCommandRunner = (command: string, args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;

export function resolveRevealablePath(raw: string): string {
  const resolved = path.resolve(expandSessionCwd(raw));
  if (!sessionCwdAllowed(resolved)) throw new Error('这个路径不能打开');
  return resolved;
}

export function openRevealArgs(resolved: string, isDirectory: boolean): string[] {
  return isDirectory ? [resolved] : ['-R', resolved];
}

/** 默认程序打开：目录和文件都直接 `open`，文件不再 `-R` 只揭示。 */
export function openDefaultArgs(resolved: string): string[] {
  return [resolved];
}

function defaultRunner(command: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk) => out.push(chunk as Buffer));
    child.stderr.on('data', (chunk) => err.push(chunk as Buffer));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        code: code ?? 1,
      });
    });
  });
}

export async function revealLocalPath(raw: string, run: FolderCommandRunner = defaultRunner): Promise<{ path: string }> {
  const resolved = resolveRevealablePath(raw);
  const stats = await fs.stat(resolved).catch(() => null);
  if (!stats) throw new Error('这个路径不存在');
  const result = await run('/usr/bin/open', openRevealArgs(resolved, stats.isDirectory()));
  if (result.code !== 0) throw new Error(result.stderr.trim() || 'Finder 打不开这个路径');
  return { path: resolved };
}

export async function openLocalPath(raw: string, run: FolderCommandRunner = defaultRunner): Promise<{ path: string }> {
  const resolved = resolveRevealablePath(raw);
  const stats = await fs.stat(resolved).catch(() => null);
  if (!stats) throw new Error('这个路径不存在');
  const result = await run('/usr/bin/open', openDefaultArgs(resolved));
  if (result.code !== 0) throw new Error(result.stderr.trim() || '打不开这个路径');
  return { path: resolved };
}

export async function pickLocalFolder(run: FolderCommandRunner = defaultRunner): Promise<{ path: string } | { cancelled: true }> {
  if (run === defaultRunner && process.platform !== 'darwin') throw new Error('只有本机 Mac 才能选目录');
  const result = await run('/usr/bin/osascript', ['-e', 'POSIX path of (choose folder with prompt "选择会话目录")']);
  const text = result.stdout.trim().replace(/\/+$/, '');
  if (result.code !== 0) {
    if (/user canceled|-128/i.test(`${result.stderr}\n${result.stdout}`)) return { cancelled: true };
    throw new Error(result.stderr.trim() || '选不了目录');
  }
  if (!text) return { cancelled: true };
  return { path: resolveRevealablePath(text) };
}
