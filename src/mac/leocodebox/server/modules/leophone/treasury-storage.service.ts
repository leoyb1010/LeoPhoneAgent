import { promises as fs } from 'node:fs';
import path from 'node:path';

import { getDatabasePath, treasuryDb } from '@/modules/database/index.js';

export type TreasuryStorageUsage = {
  original_bytes: number;
  original_files: number;
  body_cache_bytes: number;
  body_cache_entries: number;
  attachment_cache_bytes: number;
  attachment_cache_files: number;
  attachment_cache_entries: number;
};

type DirectoryUsage = { bytes: number; files: number };

export class UnsafeTreasuryStoragePathError extends Error {
  constructor() {
    super('Unsafe Treasury storage path');
    this.name = 'UnsafeTreasuryStoragePathError';
  }
}

function storagePaths(): { originals: string; attachments: string } {
  const databaseDirectory = path.dirname(getDatabasePath());
  return {
    originals: path.join(databaseDirectory, 'treasury', 'files'),
    attachments: path.join(databaseDirectory, 'treasury-assets'),
  };
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function assertWithin(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new UnsafeTreasuryStoragePathError();
  }
}

async function controlledDirectory(root: string): Promise<string | null> {
  let stat;
  try {
    stat = await fs.lstat(root);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new UnsafeTreasuryStoragePathError();
  return fs.realpath(root);
}

async function directoryUsage(root: string): Promise<DirectoryUsage> {
  const realRoot = await controlledDirectory(root);
  if (!realRoot) return { bytes: 0, files: 0 };
  let bytes = 0;
  let files = 0;
  const pending = [realRoot];
  while (pending.length) {
    const directory = pending.pop()!;
    const names = await fs.readdir(directory);
    for (const name of names) {
      const entry = path.join(directory, name);
      const stat = await fs.lstat(entry);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        const real = await fs.realpath(entry);
        assertWithin(realRoot, real);
        pending.push(real);
      } else if (stat.isFile()) {
        const real = await fs.realpath(entry);
        assertWithin(realRoot, real);
        bytes = Math.min(Number.MAX_SAFE_INTEGER, bytes + stat.size);
        files += 1;
      } else {
        throw new UnsafeTreasuryStoragePathError();
      }
    }
  }
  return { bytes, files };
}

async function clearDirectoryContents(root: string): Promise<DirectoryUsage> {
  const realRoot = await controlledDirectory(root);
  if (!realRoot) return { bytes: 0, files: 0 };
  let bytes = 0;
  let files = 0;

  const removeEntry = async (entry: string): Promise<void> => {
    const stat = await fs.lstat(entry);
    if (stat.isSymbolicLink()) {
      await fs.unlink(entry);
      return;
    }
    const real = await fs.realpath(entry);
    assertWithin(realRoot, real);
    if (stat.isFile()) {
      bytes = Math.min(Number.MAX_SAFE_INTEGER, bytes + stat.size);
      files += 1;
      await fs.unlink(entry);
      return;
    }
    if (!stat.isDirectory()) throw new UnsafeTreasuryStoragePathError();
    for (const name of await fs.readdir(real)) await removeEntry(path.join(real, name));
    await fs.rmdir(real);
  };

  for (const name of await fs.readdir(realRoot)) await removeEntry(path.join(realRoot, name));
  return { bytes, files };
}

export async function getTreasuryStorageUsage(): Promise<TreasuryStorageUsage> {
  const paths = storagePaths();
  const [originals, attachments] = await Promise.all([
    directoryUsage(paths.originals),
    directoryUsage(paths.attachments),
  ]);
  const remote = treasuryDb.remoteAssetUsage();
  return {
    original_bytes: originals.bytes,
    original_files: originals.files,
    body_cache_bytes: remote.bodyBytes,
    body_cache_entries: remote.bodyEntries,
    attachment_cache_bytes: attachments.bytes,
    attachment_cache_files: attachments.files,
    attachment_cache_entries: remote.attachmentEntries,
  };
}

export async function clearTreasuryCache(
  kind: 'body' | 'attachment',
): Promise<{ removed_bytes: number; removed_entries: number; usage: TreasuryStorageUsage }> {
  // Validate every managed root before mutating either the filesystem or DB.
  // A replaced/symlinked cache path must fail without a partial cleanup.
  await getTreasuryStorageUsage();
  if (kind === 'body') {
    const removed = treasuryDb.deleteRemoteAssets('body');
    return { removed_bytes: removed.bytes, removed_entries: removed.entries,
      usage: await getTreasuryStorageUsage() };
  }

  const removedFiles = await clearDirectoryContents(storagePaths().attachments);
  const removedRecords = treasuryDb.deleteRemoteAssets('attachment');
  return {
    removed_bytes: removedFiles.bytes,
    removed_entries: Math.max(removedFiles.files, removedRecords.entries),
    usage: await getTreasuryStorageUsage(),
  };
}
