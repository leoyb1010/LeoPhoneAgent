import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { expandSessionCwd, sessionCwdAllowed } from './session-workspace.js';

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

function initFail(stderr: string, fallback: string): Error {
  const text = stderr.replace(/\s+/g, ' ').trim();
  if (/Permission denied|Operation not permitted/i.test(text)) return new Error('这个目录写不进去');
  if (/already exists/i.test(text)) return new Error('已经是仓库');
  return new Error(text || fallback);
}

async function currentBranch(root: string): Promise<string> {
  const named = await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (named.code === 0 && named.stdout.trim() && named.stdout.trim() !== 'HEAD') return named.stdout.trim();
  const symbolic = await runGit(root, ['symbolic-ref', '--short', 'HEAD']);
  return symbolic.stdout.trim();
}

export async function initSessionRepo(cwd: string): Promise<{ root: string; created: boolean; branch: string }> {
  const sessionRoot = await fs.realpath(path.resolve(expandSessionCwd(cwd)));
  if (!sessionCwdAllowed(sessionRoot)) throw new Error('这个目录不能做成仓库');

  const existing = await runGit(sessionRoot, ['rev-parse', '--show-toplevel']);
  if (existing.code === 0 && existing.stdout.trim()) {
    const root = await fs.realpath(existing.stdout.trim());
    return { root, created: false, branch: await currentBranch(root) };
  }

  const args = ['init'];
  if (args.includes('--force') || args.includes('-f') || args.includes('--bare') || args.includes('--template')) {
    throw new Error('不能强制覆盖');
  }
  const inited = await runGit(sessionRoot, args);
  if (inited.code !== 0) throw initFail(inited.stderr, '做不成仓库');

  const top = await runGit(sessionRoot, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0 || !top.stdout.trim()) throw new Error('做成仓库了，但读不出根目录');
  const root = await fs.realpath(top.stdout.trim());
  return { root, created: true, branch: await currentBranch(root) };
}
