import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { expandSessionCwd, sessionCwdAllowed } from './session-workspace.js';

export const UNPACK_FILE_MAX = 80;

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

function zipEntryRel(entry: string): string | null {
  const cleaned = entry.replace(/\u0000/g, '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!cleaned || cleaned.endsWith('/')) return null;
  if (cleaned.startsWith('-')) throw new Error('这份 zip 里有不合法的路径');
  if (cleaned.split('/').some((part) => part === '..' || part === '')) throw new Error('这份 zip 会写到目录外面');
  if (/^__macosx\//i.test(cleaned) || /(^|\/)\.ds_store$/i.test(cleaned)) return null;
  return cleaned;
}

function resolveZipRel(root: string, file: string): string {
  const trimmed = file.trim();
  if (!trimmed || trimmed.startsWith('-')) throw new Error('文件名不合法');
  if (!trimmed.toLowerCase().endsWith('.zip')) throw new Error('只能解开 zip');
  const abs = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(root, trimmed);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('只能解开这个会话目录里的 zip');
  return rel.split(path.sep).join('/');
}

async function newestZipInCwd(root: string): Promise<string> {
  const names = await fs.readdir(root);
  const found: Array<{ name: string; mtime: number }> = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.zip')) continue;
    const abs = path.join(root, name);
    const stat = await fs.lstat(abs).catch(() => null);
    if (!stat?.isFile()) continue;
    found.push({ name, mtime: stat.mtimeMs });
  }
  found.sort((a, b) => b.mtime - a.mtime);
  if (!found[0]) throw new Error('会话目录里没有 zip');
  return found[0].name;
}

async function listZipEntries(zipPath: string): Promise<string[]> {
  const listed = await run(path.dirname(zipPath), '/usr/bin/unzip', ['-Z', '-1', '--', zipPath]);
  if (listed.code !== 0) throw new Error(listed.stderr.replace(/\s+/g, ' ').trim() || '这不是一份能解开的 zip');
  return listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

export async function unpackSessionZip(cwd: string, input: { name?: string } = {}): Promise<{ name: string; files: string[] }> {
  const sessionRoot = await fs.realpath(path.resolve(expandSessionCwd(cwd)));
  if (!sessionCwdAllowed(sessionRoot)) throw new Error('这个目录不能解开 zip');
  const relZip = input.name?.trim() ? resolveZipRel(sessionRoot, input.name) : await newestZipInCwd(sessionRoot);
  const zipAbs = path.join(sessionRoot, relZip);
  const zipStat = await fs.lstat(zipAbs).catch(() => null);
  if (!zipStat?.isFile()) throw new Error('会话目录里没有这份 zip');
  const entries = await listZipEntries(zipAbs);
  const files: string[] = [];
  for (const entry of entries) {
    const rel = zipEntryRel(entry);
    if (!rel) continue;
    const dest = path.resolve(sessionRoot, rel);
    const destRel = path.relative(sessionRoot, dest);
    if (!destRel || destRel.startsWith('..') || path.isAbsolute(destRel)) throw new Error('这份 zip 会写到目录外面');
    if (dest === zipAbs) continue;
    if (!files.includes(rel)) files.push(rel);
  }
  if (!files.length) throw new Error('这份 zip 里没有可解开的文件');
  if (files.length > UNPACK_FILE_MAX) throw new Error(`一次最多解开 ${UNPACK_FILE_MAX} 个文件`);

  const tmp = path.join(sessionRoot, `.leo-unpack-${process.pid}-${Date.now()}`);
  await fs.mkdir(tmp, { recursive: true, mode: 0o700 });
  try {
    const extracted = await run(sessionRoot, '/usr/bin/unzip', ['-o', '-qq', '--', zipAbs, ...files, '-d', tmp]);
    if (extracted.code !== 0) throw new Error(extracted.stderr.replace(/\s+/g, ' ').trim() || '解不开这份 zip');
    const tmpRoot = await fs.realpath(tmp);
    for (const file of files) {
      const src = path.join(tmp, file);
      const srcStat = await fs.lstat(src).catch(() => null);
      if (!srcStat || srcStat.isSymbolicLink() || srcStat.isDirectory()) throw new Error('这份 zip 会写到目录外面');
      const srcReal = await fs.realpath(src);
      const fromTmp = path.relative(tmpRoot, srcReal);
      if (!fromTmp || fromTmp.startsWith('..') || path.isAbsolute(fromTmp)) throw new Error('这份 zip 会写到目录外面');
      const dest = path.join(sessionRoot, file);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.rename(srcReal, dest);
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
  return { name: path.basename(relZip), files };
}
