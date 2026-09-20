import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { expandSessionCwd, sessionCwdAllowed } from './session-workspace.js';

export const BRANCH_NAME_MAX = 80;

export function sanitizeBranchName(raw: string): string {
  const parts = String(raw ?? '').replace(/\u0000/g, '').replace(/\\/g, '/').trim().split('/').map((part) => {
    const clean = part.replace(/[^\w.\u4e00-\u9fff-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!clean || clean === '.' || clean === '..' || clean.toUpperCase() === 'HEAD') return '';
    return clean;
  }).filter(Boolean);
  return parts.join('/').slice(0, BRANCH_NAME_MAX) || 'leo-分支';
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

function branchFail(stderr: string, fallback: string): Error {
  const text = stderr.replace(/\s+/g, ' ').trim();
  if (/already exists/i.test(text)) return new Error('已经有这条分支');
  if (/would be overwritten|local changes/i.test(text)) return new Error('工作区还有改动，切不过去');
  if (/not a git repository/i.test(text)) return new Error('这个目录没有 git，开不了分支');
  return new Error(text || fallback);
}

export async function switchSessionBranch(cwd: string, name: string): Promise<{ branch: string; created: boolean }> {
  const branch = sanitizeBranchName(name);
  if (branch.startsWith('-')) throw new Error('分支名不合法');
  const sessionRoot = await fs.realpath(path.resolve(expandSessionCwd(cwd)));
  if (!sessionCwdAllowed(sessionRoot)) throw new Error('这个目录不能开分支');
  const top = await runGit(sessionRoot, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0 || !top.stdout.trim()) throw new Error('这个目录没有 git，开不了分支');
  const root = await fs.realpath(top.stdout.trim());
  const exists = await runGit(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  const args = exists.code === 0 ? ['switch', branch] : ['switch', '-c', branch];
  if (args.includes('--force') || args.includes('-f')) throw new Error('不能强制覆盖');
  const switched = await runGit(root, args);
  if (switched.code !== 0) throw branchFail(switched.stderr, exists.code === 0 ? '切不过去' : '开不了这条分支');
  const now = await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const current = now.stdout.trim();
  if (now.code !== 0 || current !== branch) throw new Error('分支没切过去');
  return { branch, created: exists.code !== 0 };
}
