import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

import {
  displayConfigPath,
  homeDir,
  switchDir,
  TARGETS,
  targetConfigPaths,
} from './provider-switch.config.js';
import type { ProviderStore } from './provider-store.service.js';
import {
  captureFiles,
  ensureDir,
  fileExists,
  nowIso,
  readJsonFile,
  writeJsonFile,
} from './provider-switch.storage.js';
import type { FileSnapshot } from './provider-switch.storage.js';

type DefaultSnapshotPayload = {
  version: number;
  target: string;
  createdAt: string;
  files: Array<{ path: string; exists: boolean; mode: number; contents: string | null }>;
};

function backupRelativePath(filePath: string): string {
  const resolvedFilePath = path.resolve(filePath);
  const relativeToHome = path.relative(path.resolve(homeDir()), resolvedFilePath);
  const isInsideHome = relativeToHome
    && !relativeToHome.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativeToHome);
  return isInsideHome
    ? relativeToHome
    : path.join('__external__', Buffer.from(resolvedFilePath).toString('base64url'));
}

async function backupFile(filePath: string): Promise<string | null> {
  if (!(await fileExists(filePath))) return null;
  const relative = backupRelativePath(filePath);
  const backupPath = path.join(
    switchDir(),
    'backups',
    new Date().toISOString().replace(/[:.]/g, '-'),
    relative || path.basename(filePath),
  );
  await ensureDir(path.dirname(backupPath));
  await fs.copyFile(filePath, backupPath);
  try {
    await fs.chmod(backupPath, 0o600);
  } catch {
    // chmod is best-effort on filesystems that support POSIX modes.
  }
  return backupPath;
}

function defaultSnapshotPath(target: string): string {
  return path.join(switchDir(), 'defaults', `${target}.json`);
}

async function findEarliestBackup(filePath: string): Promise<FileSnapshot | null> {
  const root = path.join(switchDir(), 'backups');
  const relative = backupRelativePath(filePath);
  let folders: string[] = [];
  try {
    folders = (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return null;
  }

  for (const folder of folders) {
    const candidate = path.join(root, folder, relative);
    try {
      const [contents, stats] = await Promise.all([fs.readFile(candidate), fs.stat(candidate)]);
      return { filePath, exists: true, contents, mode: stats.mode & 0o777 };
    } catch {
      // Keep looking: older backup folders may not contain every target file.
    }
  }
  return null;
}

async function ensureDefaultSnapshot(target: string, store: ProviderStore): Promise<string> {
  const snapshotPath = defaultSnapshotPath(target);
  if (await fileExists(snapshotPath)) return snapshotPath;

  const managedBeforeMigration = Boolean(store.activeByTarget?.[target]);
  const currentSnapshots = await captureFiles(targetConfigPaths(target));
  const snapshots = await Promise.all(currentSnapshots.map(async (snapshot) => {
    if (!managedBeforeMigration) return snapshot;
    return (await findEarliestBackup(snapshot.filePath)) || snapshot;
  }));
  const payload = {
    version: 1,
    target,
    createdAt: nowIso(),
    files: snapshots.map((snapshot) => ({
      path: snapshot.filePath,
      exists: snapshot.exists,
      mode: snapshot.mode || 0o600,
      contents: snapshot.exists && snapshot.contents ? snapshot.contents.toString('base64') : null,
    })),
  };
  await writeJsonFile(snapshotPath, payload);
  return snapshotPath;
}

async function readDefaultSnapshot(target: string): Promise<FileSnapshot[] | null> {
  const payload = await readJsonFile<DefaultSnapshotPayload | null>(defaultSnapshotPath(target), null);
  if (!payload || payload.target !== target || !Array.isArray(payload.files)) return null;
  const expectedPaths = new Set(targetConfigPaths(target).map((filePath) => path.resolve(filePath)));
  const snapshots = payload.files.map((file) => ({
    filePath: String(file.path || ''),
    exists: Boolean(file.exists),
    mode: Number(file.mode) || 0o600,
    contents: file.exists ? Buffer.from(String(file.contents || ''), 'base64') : undefined,
  })).filter((file) => file.filePath);
  const restoredPaths = new Set(snapshots.map((snapshot) => path.resolve(snapshot.filePath)));
  if (
    snapshots.length !== expectedPaths.size
    || restoredPaths.size !== expectedPaths.size
    || [...restoredPaths].some((filePath) => !expectedPaths.has(filePath))
  ) {
    return null;
  }
  return snapshots;
}

function resolveBackupDestination(relativePath: string): string | null {
  const parts = relativePath.split(/[\\/]+/).filter(Boolean);
  if (parts.length < 2) return null;
  if (parts[1] === '__external__') {
    if (parts.length !== 3) return null;
    try {
      const decoded = Buffer.from(parts[2], 'base64url').toString('utf8');
      return path.isAbsolute(decoded) ? path.resolve(decoded) : null;
    } catch {
      return null;
    }
  }
  return path.resolve(homeDir(), ...parts.slice(1));
}

function allowedConfigDestinations(): Set<string> {
  return new Set(
    Object.keys(TARGETS)
      .flatMap((targetId) => targetConfigPaths(targetId))
      .map((filePath) => path.resolve(filePath)),
  );
}

function configStatus(): Record<string, unknown> {
  return Object.fromEntries(Object.entries(TARGETS).map(([id, target]) => {
    const configPaths = targetConfigPaths(id);
    const files = configPaths.map((resolvedPath) => {
      return {
        path: displayConfigPath(resolvedPath),
        resolvedPath,
        exists: fsSync.existsSync(resolvedPath),
      };
    });
    return [id, { ...target, configPaths: configPaths.map(displayConfigPath), files }];
  }));
}


export {
  allowedConfigDestinations,
  backupFile,
  configStatus,
  defaultSnapshotPath,
  ensureDefaultSnapshot,
  readDefaultSnapshot,
  resolveBackupDestination,
};
