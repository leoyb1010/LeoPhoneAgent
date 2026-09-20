import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { sanitizeBranchName } from './session-branch.js';
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

function mergeFail(stderr: string, fallback: string): Error {
  const text = stderr.replace(/\s+/g, ' ').trim();
  if (/would be overwritten|local changes|Please commit your changes or stash/i.test(text)) {
    return new Error('工作区还有改动，并不过去');
  }
  if (/not a git repository/i.test(text)) return new Error('这个目录没有 git，并不能过来');
  if (/conflict|CONFLICT/i.test(text)) return new Error('有冲突，并不过去');
  return new Error(text || fallback);
}

export async function mergeSessionBranch(cwd: string, name: string): Promise<{ from: string; into: string; already: boolean }> {
  if (!String(name ?? '').trim()) throw new Error('写要并过来的分支');
  const branch = sanitizeBranchName(name);
  if (!branch || branch.startsWith('-')) throw new Error('分支名不合法');

  const sessionRoot = await fs.realpath(path.resolve(expandSessionCwd(cwd)));
  if (!sessionCwdAllowed(sessionRoot)) throw new Error('这个目录不能并分支');

  const top = await runGit(sessionRoot, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0 || !top.stdout.trim()) throw new Error('这个目录没有 git，并不能过来');
  const root = await fs.realpath(top.stdout.trim());

  const now = await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const into = now.stdout.trim();
  if (now.code !== 0 || !into || into === 'HEAD') throw new Error('现在不在一条分支上');
  if (into === branch) throw new Error('已经在这条分支上');

  const exists = await runGit(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  if (exists.code !== 0) throw new Error('没有这条分支');

  const args = ['merge', '--no-edit', '--', branch];
  if (args.includes('--force') || args.includes('-f') || args.includes('--rebase') || args.includes('--squash')) {
    throw new Error('不能强制覆盖');
  }
  const merged = await runGit(root, args);
  if (merged.code !== 0) {
    await runGit(root, ['merge', '--abort']);
    throw mergeFail(`${merged.stderr} ${merged.stdout}`, '并不能过来');
  }

  const already = /Already up to date/i.test(merged.stdout);
  const ancestor = await runGit(root, ['merge-base', '--is-ancestor', `refs/heads/${branch}`, 'HEAD']);
  if (ancestor.code !== 0) throw new Error('并过来了，但读不出结果');
  return { from: branch, into, already };
}
