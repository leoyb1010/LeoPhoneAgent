import { promises as fs } from 'node:fs';
import path from 'node:path';

import { WORKSPACES_ROOT } from '@/shared/utils.js';

export type PathValidation = {
  valid: boolean;
  resolved?: string;
  realPath?: string;
  error?: string;
};

export type FileTreeNode = {
  name: string;
  path: string;
  type: 'directory' | 'file';
  size?: number;
  modified?: string | null;
  isSymlink?: boolean;
  permissions?: string;
  permissionsRwx?: string;
  children?: FileTreeNode[];
};

const IGNORED_DIRS = new Set([
  'node_modules', 'dist', 'build', '.next', '.nuxt', '.cache', '.parcel-cache',
  '.git', '.svn', '.hg',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.tox', 'venv', '.venv',
  'target', 'vendor',
  '.gradle', '.idea', 'coverage', '.nyc_output',
]);

const parsedFsConcurrency = Number.parseInt(process.env.FS_CONCURRENCY || '', 10);
const FS_CONCURRENCY = Number.isFinite(parsedFsConcurrency) && parsedFsConcurrency > 0
  ? parsedFsConcurrency
  : 64;
let activeFsOperations = 0;
const pendingFsOperations: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (activeFsOperations < FS_CONCURRENCY) {
    activeFsOperations += 1;
    return;
  }
  await new Promise<void>((resolve) => pendingFsOperations.push(resolve));
}

function release(): void {
  const next = pendingFsOperations.shift();
  if (next) next();
  else activeFsOperations = Math.max(0, activeFsOperations - 1);
}

function permToRwx(permission: number): string {
  return `${permission & 4 ? 'r' : '-'}${permission & 2 ? 'w' : '-'}${permission & 1 ? 'x' : '-'}`;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as NodeJS.ErrnoException).code || '')
    : undefined;
}

export function expandWorkspacePath(inputPath: string): string {
  if (inputPath === '~') return WORKSPACES_ROOT;
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return path.join(WORKSPACES_ROOT, inputPath.slice(2));
  }
  return inputPath;
}

export function validatePathInProject(projectRoot: string, targetPath: string): PathValidation {
  const resolved = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(projectRoot, targetPath);
  const normalizedRoot = `${path.resolve(projectRoot)}${path.sep}`;
  if (!resolved.startsWith(normalizedRoot)) {
    return { valid: false, error: 'Path must be under project root' };
  }
  return { valid: true, resolved };
}

export async function assertRealPathWithinRoot(
  projectRoot: string,
  resolvedPath: string,
  { allowMissing = false }: { allowMissing?: boolean } = {},
): Promise<PathValidation> {
  let realRoot: string;
  try {
    realRoot = await fs.realpath(path.resolve(projectRoot));
  } catch {
    return { valid: false, error: 'Project root is not accessible' };
  }

  let candidate = path.resolve(resolvedPath);
  let realTarget: string | null = null;
  const missingTail: string[] = [];
  while (true) {
    try {
      realTarget = await fs.realpath(candidate);
      break;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT' || !allowMissing) {
        return { valid: false, error: 'Path is not accessible' };
      }
      missingTail.unshift(path.basename(candidate));
      const parent = path.dirname(candidate);
      if (parent === candidate) return { valid: false, error: 'Path must be under project root' };
      candidate = parent;
    }
  }

  const finalReal = missingTail.length > 0 ? path.join(realTarget, ...missingTail) : realTarget;
  const rootWithSep = realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`;
  if (finalReal !== realRoot && !finalReal.startsWith(rootWithSep)) {
    return { valid: false, error: 'Resolved path escapes the project root' };
  }
  return { valid: true, realPath: finalReal };
}

export function validateFilename(name: string): { valid: boolean; error?: string } {
  if (!name || !name.trim()) return { valid: false, error: 'Filename cannot be empty' };
  if (/[<>:"/\\|?*\x00-\x1f]/.test(name)) return { valid: false, error: 'Filename contains invalid characters' };
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name)) return { valid: false, error: 'Filename is a reserved name' };
  if (/^\.+$/.test(name)) return { valid: false, error: 'Filename cannot be only dots' };
  return { valid: true };
}

export async function getFileTree(
  dirPath: string,
  maxDepth = 3,
  currentDepth = 0,
  _showHidden = true,
): Promise<FileTreeNode[]> {
  let entries;
  try {
    await acquire();
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } finally {
      release();
    }
  } catch (error) {
    if (!['EACCES', 'EPERM'].includes(errorCode(error) || '')) console.error('Error reading directory:', error);
    return [];
  }

  const filteredEntries = entries.filter((entry) => !(entry.isDirectory() && IGNORED_DIRS.has(entry.name)));
  const items = await Promise.all(filteredEntries.map(async (entry): Promise<FileTreeNode> => {
    const itemPath = path.join(dirPath, entry.name);
    const item: FileTreeNode = {
      name: entry.name,
      path: itemPath,
      type: entry.isDirectory() ? 'directory' : 'file',
    };
    try {
      await acquire();
      try {
        const stats = await fs.lstat(itemPath);
        item.size = stats.size;
        item.modified = stats.mtime.toISOString();
        if (stats.isSymbolicLink()) item.isSymlink = true;
        const owner = (stats.mode >> 6) & 7;
        const group = (stats.mode >> 3) & 7;
        const other = stats.mode & 7;
        item.permissions = `${owner}${group}${other}`;
        item.permissionsRwx = `${permToRwx(owner)}${permToRwx(group)}${permToRwx(other)}`;
      } finally {
        release();
      }
    } catch {
      item.size = 0;
      item.modified = null;
      item.permissions = '000';
      item.permissionsRwx = '---------';
    }
    if (entry.isDirectory() && currentDepth < maxDepth) {
      item.children = await getFileTree(itemPath, maxDepth, currentDepth + 1, _showHidden);
    }
    return item;
  }));

  return items.sort((left, right) => {
    if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}
