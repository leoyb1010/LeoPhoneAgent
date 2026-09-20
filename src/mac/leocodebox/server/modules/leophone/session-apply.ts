import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expandSessionCwd, sessionCwdAllowed } from './session-workspace.js';

export const APPLY_PATCH_MAX = 80_000;

export function looksBinaryPatch(patch: string): boolean {
  return /Binary files |GIT binary patch/i.test(patch);
}

export function patchTargetPaths(patch: string): string[] {
  const out: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const match = line.match(/^\+\+\+\s+(?:b\/)?(.+)$/);
    if (!match) continue;
    const raw = match[1].replace(/^"+|"+$/g, '').split('\t')[0]?.trim() ?? '';
    if (!raw || raw === '/dev/null') continue;
    out.push(raw);
  }
  return [...new Set(out)];
}

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

export async function applySessionPatch(cwd: string, patch: string): Promise<{ files: string[] }> {
  const root = await fs.realpath(path.resolve(expandSessionCwd(cwd)));
  if (!sessionCwdAllowed(root)) throw new Error('这个目录不能贴补丁');
  const text = patch.replace(/\u0000/g, '');
  if (!text.trim()) throw new Error('剪贴板里没有补丁');
  if (text.length > APPLY_PATCH_MAX) throw new Error('这份补丁太长');
  if (looksBinaryPatch(text)) throw new Error('二进制补丁不能贴');
  const files = patchTargetPaths(text);
  if (!files.length) throw new Error('这不是一份能落地的补丁');
  for (const file of files) {
    if (file.startsWith('-')) throw new Error('补丁路径不合法');
    const abs = path.isAbsolute(file) ? path.resolve(file) : path.resolve(root, file);
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('补丁不能写出这个目录');
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'leo-apply-'));
  const patchFile = path.join(tmp, 'change.patch');
  try {
    await fs.writeFile(patchFile, text.endsWith('\n') ? text : `${text}\n`);
    const git = await run(root, 'git', ['apply', '--check', '--whitespace=nowarn', patchFile]);
    if (git.code === 0) {
      const applied = await run(root, 'git', ['apply', '--whitespace=nowarn', patchFile]);
      if (applied.code !== 0) throw new Error(applied.stderr.replace(/\s+/g, ' ').trim() || '补丁贴不上');
      return { files };
    }
    const patched = await run(root, 'patch', ['-p1', '--forward', '--batch', '-i', patchFile]);
    if (patched.code !== 0) {
      const why = (git.stderr || patched.stderr).replace(/\s+/g, ' ').trim();
      throw new Error(why || '补丁贴不上');
    }
    return { files };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
