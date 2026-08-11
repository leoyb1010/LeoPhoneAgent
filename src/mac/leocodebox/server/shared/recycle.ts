import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Recoverable deletes. Instead of `rm -rf`, a path is moved into a leocodebox-owned
 * trash dir with a sidecar manifest recording where it came from, so an accidental
 * or mid-write skill removal can be restored. Entries older than the retention
 * window are pruned so the trash never grows unbounded.
 */

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const trashRoot = (): string =>
  process.env.LEOCODEBOX_TRASH_DIR || path.join(os.homedir(), '.leocodebox', 'trash');

export type RecycledEntry = {
  id: string;
  trashPath: string;
  originalPath: string;
  recycledAt: string;
  meta?: Record<string, unknown>;
};

const sanitize = (value: string): string => value.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || 'entry';

// Move a directory/file, falling back to copy+remove when it would cross filesystems.
const move = async (from: string, to: string): Promise<void> => {
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
      throw error;
    }
    await cp(from, to, { recursive: true });
    await rm(from, { recursive: true, force: true });
  }
};

const manifestPathFor = (trashPath: string): string => `${trashPath}.json`;

/** Move a path into the trash, returning its recycle record. Prunes old entries first. */
export const recyclePath = async (
  sourcePath: string,
  meta?: Record<string, unknown>,
): Promise<RecycledEntry> => {
  const root = trashRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  await pruneExpiredRecycled(root).catch(() => {});

  const id = `${Date.now()}-${sanitize(path.basename(sourcePath))}-${randomUUID().slice(0, 8)}`;
  const trashPath = path.join(root, id);
  const entry: RecycledEntry = {
    id,
    trashPath,
    originalPath: path.resolve(sourcePath),
    recycledAt: new Date().toISOString(),
    meta,
  };

  // Persist the manifest BEFORE moving the content. If the move then fails
  // (e.g. a cross-filesystem cp+rm that partially fails), the worst case is a
  // dangling manifest — still listed and pruned normally — never an invisible,
  // unrecoverable, never-pruned orphan in the trash.
  await writeFile(manifestPathFor(trashPath), `${JSON.stringify(entry, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await move(path.resolve(sourcePath), trashPath);
  return entry;
};

/** List recycle records, newest first. */
export const listRecycled = async (): Promise<RecycledEntry[]> => {
  const root = trashRoot();
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }

  const entries: RecycledEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(await readFile(path.join(root, name), 'utf8')) as RecycledEntry;
      if (parsed?.id && parsed.trashPath && parsed.originalPath) entries.push(parsed);
    } catch {
      // Ignore corrupt manifests.
    }
  }
  return entries.sort((a, b) => b.recycledAt.localeCompare(a.recycledAt));
};

/** Restore a recycled entry back to its original path. Refuses to clobber an existing path. */
export const restoreRecycled = async (
  id: string,
): Promise<{ restored: boolean; originalPath: string }> => {
  const trashPath = path.join(trashRoot(), id);
  const manifestPath = manifestPathFor(trashPath);
  let entry: RecycledEntry;
  try {
    entry = JSON.parse(await readFile(manifestPath, 'utf8')) as RecycledEntry;
  } catch (error) {
    // Already restored/pruned, or an unknown id: a clean 404, never a raw fs path.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const notFound = new Error('Recycle entry not found or already restored.') as Error & { statusCode?: number };
      notFound.statusCode = 404;
      throw notFound;
    }
    throw error;
  }

  const exists = await stat(entry.originalPath).then(() => true).catch(() => false);
  if (exists) {
    return { restored: false, originalPath: entry.originalPath };
  }

  await mkdir(path.dirname(entry.originalPath), { recursive: true });
  await move(entry.trashPath, entry.originalPath);
  await rm(manifestPath, { force: true });
  return { restored: true, originalPath: entry.originalPath };
};

/** Delete recycle entries older than the retention window. */
export const pruneExpiredRecycled = async (root = trashRoot()): Promise<void> => {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return;
  }

  const cutoff = Date.now() - RETENTION_MS;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const manifestPath = path.join(root, name);
    try {
      const entry = JSON.parse(await readFile(manifestPath, 'utf8')) as RecycledEntry;
      if (new Date(entry.recycledAt).getTime() < cutoff) {
        await rm(entry.trashPath, { recursive: true, force: true }).catch(() => {});
        await rm(manifestPath, { force: true }).catch(() => {});
      }
    } catch {
      // Ignore corrupt manifests during pruning.
    }
  }
};
