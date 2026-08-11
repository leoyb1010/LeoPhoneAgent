import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const MAX_TEXT_FIELD = 20_000;

export type FileSnapshot = {
  filePath: string;
  exists: boolean;
  contents?: Buffer;
  mode?: number;
};

function toNodeError(error: unknown): NodeJS.ErrnoException {
  return error instanceof Error ? error as NodeJS.ErrnoException : new Error(String(error));
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function safeText(value: unknown, max = MAX_TEXT_FIELD): string {
  return String(value == null ? '' : value).slice(0, max).trim();
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  try { await fs.chmod(dir, 0o700); } catch { /* Best effort on POSIX filesystems. */ }
}

export async function atomicWrite(filePath: string, contents: string | Uint8Array, mode = 0o600): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, contents, { mode });
  await fs.rename(tempPath, filePath);
  try { await fs.chmod(filePath, mode); } catch { /* Best effort on POSIX filesystems. */ }
}

export async function captureFiles(filePaths: string[]): Promise<FileSnapshot[]> {
  return Promise.all(filePaths.map(async (filePath) => {
    try {
      const [contents, stats] = await Promise.all([fs.readFile(filePath), fs.stat(filePath)]);
      return { filePath, exists: true, contents, mode: stats.mode & 0o777 };
    } catch (error) {
      if (toNodeError(error).code === 'ENOENT') return { filePath, exists: false };
      throw error;
    }
  }));
}

export async function restoreFiles(snapshots: FileSnapshot[]): Promise<void> {
  for (const snapshot of snapshots) {
    if (snapshot.exists && snapshot.contents) {
      await atomicWrite(snapshot.filePath, snapshot.contents, snapshot.mode || 0o600);
    } else {
      await fs.rm(snapshot.filePath, { force: true, recursive: false });
    }
  }
}

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch (error) {
    if (toNodeError(error).code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function writeJsonFile(filePath: string, value: unknown, mode = 0o600): Promise<void> {
  await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export async function fileExists(filePath: string): Promise<boolean> {
  try { await fs.access(filePath); return true; } catch { return false; }
}
