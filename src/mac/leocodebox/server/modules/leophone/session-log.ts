import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { expandSessionCwd, sessionCwdAllowed } from './session-workspace.js';

export const SESSION_LOG_MAX = 20;

export type SessionCommit = { hash: string; subject: string; at: number };

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

function clipPatch(text: string, limit = 80_000): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…(后面还有 ${text.length - limit} 字)`;
}

export function isCommitHash(raw: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(raw.trim());
}

async function gitRoot(cwd: string): Promise<string> {
  const sessionRoot = await fs.realpath(path.resolve(expandSessionCwd(cwd)));
  if (!sessionCwdAllowed(sessionRoot)) throw new Error('这个目录不能看提交');
  const top = await runGit(sessionRoot, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0 || !top.stdout.trim()) throw new Error('这个目录没有 git，看不到提交');
  return fs.realpath(top.stdout.trim());
}

export function parseGitLogLine(line: string): SessionCommit | null {
  const [hash, at, ...rest] = line.split('\t');
  if (!hash || !isCommitHash(hash)) return null;
  const subject = rest.join('\t').replace(/\s+/g, ' ').trim();
  const seconds = Number(at);
  return { hash, subject, at: Number.isFinite(seconds) ? seconds * 1000 : 0 };
}

export async function listSessionCommits(cwd: string): Promise<{ commits: SessionCommit[] }> {
  const root = await gitRoot(cwd);
  const log = await runGit(root, ['-c', 'core.pager=', 'log', '-n', String(SESSION_LOG_MAX), '--format=%h%x09%ct%x09%s']);
  if (log.code !== 0) throw new Error(log.stderr.replace(/\s+/g, ' ').trim() || '看不到最近提交');
  const commits = log.stdout.split('\n').map((line) => parseGitLogLine(line.trim())).filter((row): row is SessionCommit => Boolean(row));
  return { commits };
}

export async function showSessionCommit(cwd: string, hash: string): Promise<{ hash: string; subject: string; patch: string }> {
  if (!isCommitHash(hash)) throw new Error('提交号不合法');
  const root = await gitRoot(cwd);
  const show = await runGit(root, ['-c', 'core.pager=', 'show', '--no-color', '--stat', '-p', hash.trim()]);
  if (show.code !== 0) throw new Error(show.stderr.replace(/\s+/g, ' ').trim() || '看不到这次提交');
  const patch = clipPatch(show.stdout.trimEnd());
  const subjectLine = patch.split('\n').find((line) => line.startsWith('    '))?.trim()
    ?? patch.split('\n').find((line) => /^[A-Z]/.test(line))?.trim()
    ?? hash.trim();
  return { hash: hash.trim(), subject: subjectLine.slice(0, 80), patch: patch || '这次提交没有可看的内容' };
}
