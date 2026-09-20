import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { expandSessionCwd, sessionCwdAllowed } from './session-workspace.js';

const PUSH_TIMEOUT_MS = 60_000;

function runGit(cwd: string, args: readonly string[], timeoutMs = PUSH_TIMEOUT_MS): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('推到远端超时了'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function pushFail(stderr: string, fallback: string): Error {
  const text = stderr.replace(/\s+/g, ' ').trim();
  if (/could not read Username|Authentication failed|Permission denied \(publickey\)|403/i.test(text)) {
    return new Error('远端要登录，先在终端里登一下');
  }
  if (/non-fast-forward|failed to push some refs|\[rejected\]/i.test(text)) {
    return new Error('远端有新提交，这里不强制覆盖');
  }
  if (/Could not resolve host|Connection refused|SSL|timed out|Could not read from remote/i.test(text)) {
    return new Error('连不上远端');
  }
  return new Error(text || fallback);
}

export async function pushSessionRepo(cwd: string): Promise<{ remote: string; branch: string }> {
  const sessionRoot = await fs.realpath(path.resolve(expandSessionCwd(cwd)));
  if (!sessionCwdAllowed(sessionRoot)) throw new Error('这个目录不能推');
  const top = await runGit(sessionRoot, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0 || !top.stdout.trim()) throw new Error('这个目录没有 git，没法推');
  const root = await fs.realpath(top.stdout.trim());
  const branchRun = await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = branchRun.stdout.trim();
  if (branchRun.code !== 0 || !branch || branch === 'HEAD') throw new Error('现在不在分支上，没法推');

  const remotesRun = await runGit(root, ['remote']);
  const remotes = remotesRun.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  if (!remotes.length) throw new Error('还没有远端');

  const upstream = await runGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  const args = upstream.code === 0 && upstream.stdout.trim()
    ? ['push']
    : ['push', '-u', remotes.includes('origin') ? 'origin' : remotes[0]!, 'HEAD'];
  if (args.some((part) => part === '--force' || part === '-f' || part.startsWith('--force'))) {
    throw new Error('不能强制覆盖远端');
  }
  const pushed = await runGit(root, args);
  if (pushed.code !== 0) throw pushFail(`${pushed.stdout}\n${pushed.stderr}`, '推不上去');

  const after = await runGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  const track = after.stdout.trim();
  const remote = track.includes('/') ? track.slice(0, track.indexOf('/')) : (remotes.includes('origin') ? 'origin' : remotes[0]!);
  const destBranch = track.includes('/') ? track.slice(track.indexOf('/') + 1) : branch;
  return { remote, branch: destBranch };
}
