import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export function getModuleDir(importMetaUrl: string): string {
  return path.dirname(fileURLToPath(importMetaUrl));
}

export function findServerRoot(startDir: string): string {
  // Source files live under /server, while compiled files live under /dist-server/server.
  // Walking up to the nearest "server" folder gives every backend module one stable anchor
  // that works in both layouts instead of relying on fragile "../.." assumptions.
  let currentDir = startDir;

  while (path.basename(currentDir) !== 'server') {
    const parentDir = path.dirname(currentDir);

    if (parentDir === currentDir) {
      throw new Error(`Could not resolve the backend server root from "${startDir}".`);
    }

    currentDir = parentDir;
  }

  return currentDir;
}

export function findAppRoot(startDir: string): string {
  const serverRoot = findServerRoot(startDir);
  const parentOfServerRoot = path.dirname(serverRoot);

  // Source files live at <app>/server, while compiled files live at <app>/dist-server/server.
  // When the nearest server folder sits inside dist-server we need to hop one extra level up
  // so repo-level files still resolve from the real app root instead of the build directory.
  return path.basename(parentOfServerRoot) === 'dist-server'
    ? path.dirname(parentOfServerRoot)
    : parentOfServerRoot;
}

/** 健康检查用:仓库是 git,装进 .app 是 bundled,其余当 npm。 */
export function detectInstallMode(appRoot: string, exists: (file: string) => boolean = (file) => fs.existsSync(file)): 'git' | 'bundled' | 'npm' {
  if (exists(path.join(appRoot, '.git'))) return 'git';
  if (appRoot.includes(`${path.sep}Contents${path.sep}Resources`)) return 'bundled';
  return 'npm';
}
