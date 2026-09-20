import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { expandSessionCwd, sessionCwdAllowed } from './session-workspace.js';

export type RevertAction = 'restored' | 'removed';

export function resolveSessionFile(cwd: string, file: string): { root: string; abs: string; rel: string } {
  const root = path.resolve(expandSessionCwd(cwd));
  if (!sessionCwdAllowed(root)) throw new Error('这个目录不能还原文件');
  const trimmed = file.trim();
  if (!trimmed) throw new Error('没有要还原的文件');
  const abs = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(root, trimmed);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('只能还原这个会话目录里的文件');
  return { root, abs, rel };
}

/** porcelain 前两列：未跟踪删掉，其余交给 git restore。 */
export function revertPlanFromPorcelain(line: string): 'restore' | 'remove' | 'none' {
  const code = line.slice(0, 2);
  if (!line.trim()) return 'none';
  if (code === '??') return 'remove';
  return 'restore';
}

function runGit(cwd: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function gitRoot(cwd: string): Promise<string> {
  const result = await runGit(cwd, ['rev-parse', '--show-toplevel']);
  const top = result.stdout.trim();
  if (result.code !== 0 || !top) throw new Error('这个目录没有 git，没法还原到改之前');
  return path.resolve(top);
}

export async function revertSessionFile(cwd: string, file: string): Promise<{ action: RevertAction; file: string }> {
  const target = resolveSessionFile(cwd, file);
  const sessionRoot = await fs.realpath(target.root);
  const root = await fs.realpath(await gitRoot(sessionRoot));
  const abs = path.resolve(sessionRoot, target.rel);
  const relGit = path.relative(root, abs);
  if (!relGit || relGit.startsWith('..') || path.isAbsolute(relGit)) {
    throw new Error('只能还原这个会话目录里的文件');
  }

  const status = await runGit(root, ['status', '--porcelain', '--', relGit]);
  const line = status.stdout.split('\n').find((row) => row.trim()) ?? '';
  const plan = revertPlanFromPorcelain(line);
  if (plan === 'none') throw new Error('这个文件没有可还原的改动');

  if (plan === 'remove') {
    const info = await fs.stat(abs).catch(() => null);
    if (!info) throw new Error('这个文件已经不在了');
    if (!info.isFile()) throw new Error('只能还原普通文件');
    await fs.unlink(abs);
    return { action: 'removed', file: target.rel };
  }

  const restored = await runGit(root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', relGit]);
  if (restored.code !== 0) {
    await runGit(root, ['reset', 'HEAD', '--', relGit]);
    const info = await fs.stat(abs).catch(() => null);
    if (info?.isFile()) await fs.unlink(abs);
    return { action: 'removed', file: target.rel };
  }
  return { action: 'restored', file: target.rel };
}
