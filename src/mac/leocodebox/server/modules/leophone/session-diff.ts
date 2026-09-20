import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { expandSessionCwd, sessionCwdAllowed } from './session-workspace.js';

export type SessionDiffKind = 'modified' | 'added' | 'clean' | 'binary';

export function looksBinaryDiff(patch: string): boolean {
  return /Binary files |GIT binary patch/i.test(patch);
}

export function clipSessionDiff(text: string, limit = 80_000): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…(后面还有 ${text.length - limit} 字)`;
}

function resolveSessionFile(cwd: string, file: string): { root: string; rel: string } {
  const root = path.resolve(expandSessionCwd(cwd));
  if (!sessionCwdAllowed(root)) throw new Error('这个目录不能看改动');
  const trimmed = file.trim();
  if (!trimmed) throw new Error('没有要看的文件');
  if (trimmed.startsWith('-')) throw new Error('文件名不合法');
  const abs = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(root, trimmed);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('只能看这个会话目录里的文件');
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

function porcelainCode(line: string): string {
  return line.slice(0, 2);
}

export async function diffSessionFile(cwd: string, file: string): Promise<{ file: string; kind: SessionDiffKind; patch: string }> {
  const target = resolveSessionFile(cwd, file);
  const sessionRoot = await fs.realpath(target.root);
  const top = await runGit(sessionRoot, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0 || !top.stdout.trim()) throw new Error('这个目录没有 git，没法看这次改了什么');
  const root = await fs.realpath(top.stdout.trim());
  const abs = path.resolve(sessionRoot, target.rel);
  const relGit = path.relative(root, abs);
  if (!relGit || relGit.startsWith('..') || path.isAbsolute(relGit)) throw new Error('只能看这个会话目录里的文件');

  const againstHead = await runGit(root, ['-c', 'core.pager=', 'diff', '--no-color', 'HEAD', '--', relGit]);
  const headPatch = againstHead.stdout.trimEnd();
  if (headPatch) {
    if (looksBinaryDiff(headPatch)) {
      return { file: target.rel, kind: 'binary', patch: '这是二进制，看不到改动' };
    }
    return { file: target.rel, kind: 'modified', patch: clipSessionDiff(headPatch) };
  }

  const status = await runGit(root, ['status', '--porcelain', '--', relGit]);
  const line = status.stdout.split('\n').find((row) => row.trim()) ?? '';
  if (porcelainCode(line) === '??') {
    const added = await runGit(root, ['-c', 'core.pager=', 'diff', '--no-color', '--no-index', '--', '/dev/null', relGit]);
    const patch = added.stdout.trimEnd();
    if (!patch) throw new Error('这个文件没有可看的改动');
    if (looksBinaryDiff(patch)) {
      return { file: target.rel, kind: 'binary', patch: '这是二进制，看不到改动' };
    }
    return { file: target.rel, kind: 'added', patch: clipSessionDiff(patch) };
  }

  return { file: target.rel, kind: 'clean', patch: '这个文件没有可看的改动' };
}
