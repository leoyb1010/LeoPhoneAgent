import fs from 'node:fs';
import path from 'node:path';

const cache = new Map<string, boolean>();

export function detectTypeScriptProject(workdir: string): boolean {
  if (!workdir) return false;
  const normalized = path.resolve(workdir);
  const cached = cache.get(normalized);
  if (cached !== undefined) return cached;

  const result = detect(normalized);
  cache.set(normalized, result);
  return result;
}

const MONOREPO_MARKERS = [
  'pnpm-workspace.yaml',
  'lerna.json',
  'nx.json',
  'turbo.json',
  'rush.json',
];

function detect(workdir: string): boolean {
  if (fs.existsSync(path.join(workdir, 'tsconfig.json'))) return true;
  if (MONOREPO_MARKERS.some((marker) => fs.existsSync(path.join(workdir, marker)))) return true;

  const packageJsonPath = path.join(workdir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) return false;

  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      workspaces?: unknown;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    if (pkg.workspaces) return true;
    return Boolean(
      pkg.dependencies?.typescript ||
        pkg.devDependencies?.typescript ||
        pkg.peerDependencies?.typescript,
    );
  } catch {
    return false;
  }
}
