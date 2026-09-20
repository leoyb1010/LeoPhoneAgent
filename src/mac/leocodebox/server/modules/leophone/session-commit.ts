import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { expandSessionCwd, sessionCwdAllowed } from './session-workspace.js';

export const COMMIT_MESSAGE_MAX = 200;
export const COMMIT_FILE_MAX = 40;

export function clipCommitMessage(raw: string): string {
  return raw.replace(/[\r\n\u0000]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, COMMIT_MESSAGE_MAX);
}

function resolveSessionFile(cwd: string, file: string): { root: string; rel: string } {
  const root = path.resolve(expandSessionCwd(cwd));
  if (!sessionCwdAllowed(root)) throw new Error('这个目录不能记下改动');
  const trimmed = file.trim();
  if (!trimmed) throw new Error('没有要记下的文件');
  if (trimmed.startsWith('-')) throw new Error('文件名不合法');
  const abs = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(root, trimmed);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('只能记下这个会话目录里的文件');
  return { root, rel };
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

function gitFail(stderr: string, fallback: string): Error {
  const text = stderr.replace(/\s+/g, ' ').trim();
  if (/Please tell me who you are/i.test(text)) return new Error('这个仓库还没设置 git 用户名，没法记下');
  if (/nothing to commit/i.test(text)) return new Error('这些文件没有可记下的改动');
  return new Error(text || fallback);
}

export async function commitSessionFiles(cwd: string, input: { message: string; files: readonly string[] }): Promise<{ hash: string; files: string[]; message: string }> {
  const message = clipCommitMessage(input.message);
  if (!message) throw new Error('写一句这次改了什么');
  if (message.startsWith('-')) throw new Error('说明不能以 - 开头');

  const names = [...new Set(input.files.map((file) => file.trim()).filter(Boolean))];
  if (!names.length) throw new Error('没有要记下的文件');
  if (names.length > COMMIT_FILE_MAX) throw new Error(`一次最多记下 ${COMMIT_FILE_MAX} 个文件`);

  const first = resolveSessionFile(cwd, names[0]!);
  const sessionRoot = await fs.realpath(first.root);
  const top = await runGit(sessionRoot, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0 || !top.stdout.trim()) throw new Error('这个目录没有 git，没法记下这次改动');
  const root = await fs.realpath(top.stdout.trim());

  const rels: string[] = [];
  for (const name of names) {
    const target = resolveSessionFile(cwd, name);
    const abs = path.resolve(sessionRoot, target.rel);
    const relGit = path.relative(root, abs);
    if (!relGit || relGit.startsWith('..') || path.isAbsolute(relGit)) throw new Error('只能记下这个会话目录里的文件');
    rels.push(relGit);
  }

  for (const rel of rels) {
    const added = await runGit(root, ['add', '--', rel]);
    if (added.code !== 0) throw gitFail(added.stderr, '加不进这次改动');
  }

  const staged = await runGit(root, ['diff', '--cached', '--name-only', '--', ...rels]);
  if (!staged.stdout.trim()) throw new Error('这些文件没有可记下的改动');

  const committed = await runGit(root, ['commit', '-m', message, '--', ...rels]);
  if (committed.code !== 0) throw gitFail(committed.stderr, '记不进 git');

  const hash = (await runGit(root, ['rev-parse', '--short', 'HEAD'])).stdout.trim();
  if (!hash) throw new Error('记下了，但读不出提交号');
  return { hash, files: rels, message };
}
