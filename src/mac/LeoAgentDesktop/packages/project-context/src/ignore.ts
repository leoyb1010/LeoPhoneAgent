import fs from 'node:fs';
import path from 'node:path';
import ignoreModule from 'ignore';
import type { Ignore } from 'ignore';

// `ignore` ships as CJS (module.exports = factory). Under Node16 module resolution +
// esModuleInterop the default import binds to the factory at runtime, but the
// TS .d.ts wraps it in a way that the imported binding is typed as a namespace.
// Cast once here so call sites stay clean.
const ignore = ignoreModule as unknown as () => Ignore;

/**
 * Built-in ignore patterns. These supplement .gitignore for things that may be
 * git-tracked but agent shouldn't read (lock files, snapshots, generated migrations,
 * minified bundles).
 */
const BUILTIN_IGNORE: string[] = [
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.git',
  '.next',
  '.turbo',
  '.cache',
  '*.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  '*.min.js',
  '*.min.css',
  '*.snap',
  '*.map',
  '.cindy',
  // 旧目录约定（已迁移为 .cindy）；保留忽略项防止存量残留目录被当内容扫描。
  '.xdmaker',
];

const LARGE_FILE_BYTES = 500 * 1024;

export interface IgnoreFilter {
  /** Returns true when the given path (relative to repo root) should be ignored. */
  isIgnored(relPath: string): boolean;
  /** Returns true when the file is too large to consider (skips file IO). */
  isTooLarge(absPath: string): boolean;
}

export function buildIgnoreFilter(
  repoRoot: string,
  configIgnore: string[] | undefined,
): IgnoreFilter {
  const ig: Ignore = ignore();
  ig.add(BUILTIN_IGNORE);

  const gitignorePath = path.join(repoRoot, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    ig.add(fs.readFileSync(gitignorePath, 'utf8'));
  }

  if (configIgnore && configIgnore.length > 0) {
    ig.add(configIgnore);
  }

  return {
    isIgnored(relPath: string): boolean {
      // ignore lib requires forward slashes and disallows leading slash for relative paths
      const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
      if (!normalized) return false;
      return ig.ignores(normalized);
    },
    isTooLarge(absPath: string): boolean {
      try {
        const stat = fs.statSync(absPath);
        return stat.isFile() && stat.size > LARGE_FILE_BYTES;
      } catch {
        return false;
      }
    },
  };
}
