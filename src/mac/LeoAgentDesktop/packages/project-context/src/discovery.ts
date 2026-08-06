import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import micromatch from 'micromatch';
import type { ConfigFile, DiscoveredModule } from './types.js';

/**
 * File extensions treated as "source code". A discovered directory with zero such
 * files is skipped — it's almost always a vendored binary mirror, prebuilt asset
 * pack, or pure-doc folder, none of which need an agent-maintained module file.
 */
const SOURCE_EXTENSIONS = new Set([
  // JavaScript family
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  // Other languages
  '.go',
  '.rs',
  '.py',
  '.java',
  '.kt',
  '.swift',
  '.cs',
  '.cpp',
  '.cc',
  '.c',
  '.h',
  '.hpp',
  '.rb',
  '.php',
  '.scala',
  '.lua',
  '.sh',
  // Frontend frameworks / templating
  '.vue',
  '.svelte',
  '.astro',
  // Markup + styles (covers static-only sites and component libraries)
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.sass',
  '.less',
]);

const SCAN_MAX_DEPTH = 4;
const SCAN_SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', '.git', '.next', '.cache']);

/**
 * Auto-discover module roots in priority order (D4):
 *   1. config.module_roots (explicit)
 *   2. pnpm-workspace.yaml `packages` field
 *   3. package.json `workspaces` field (npm/yarn workspaces)
 *   4. Unsupported markers (go.mod / Cargo.toml) -> error
 *
 * Candidate dirs that contain no source files are filtered out (e.g. apps/*-bin).
 */
export function discoverModules(repoRoot: string, config: ConfigFile): DiscoveredModule[] {
  const roots = resolveModuleRoots(repoRoot, config);
  // Module-level ignore: drop these dirs even if they otherwise qualify. Used
  // for self-referential / meta packages that should not have an auto-refreshed
  // knowledge file (e.g. project-context itself). See ConfigFile.module_ignore.
  const moduleIgnore = new Set(
    (config.module_ignore ?? []).map((p) => p.replace(/\\/g, '/').replace(/\/+$/, '')),
  );
  const modules: DiscoveredModule[] = [];
  for (const root of roots) {
    for (const dir of expandGlobToDirs(repoRoot, root)) {
      if (moduleIgnore.has(dir)) continue;
      if (!hasSourceFiles(path.join(repoRoot, dir))) continue;
      modules.push({
        id: kebabIdFromPath(dir),
        path: dir,
      });
    }
  }
  // Dedup by id (in case multiple globs overlap).
  const seen = new Set<string>();
  return modules.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

/**
 * Shallow recursive scan: returns true as soon as ONE source file is found.
 * Bounded by SCAN_MAX_DEPTH and skips known noise dirs to keep init fast on
 * large monorepos.
 */
function hasSourceFiles(absDir: string, depth = 0): boolean {
  if (depth > SCAN_MAX_DEPTH) return false;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SCAN_SKIP_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith('.')) continue;
      if (hasSourceFiles(path.join(absDir, entry.name), depth + 1)) return true;
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (SOURCE_EXTENSIONS.has(ext)) return true;
  }
  return false;
}

function resolveModuleRoots(repoRoot: string, config: ConfigFile): string[] {
  if (config.module_roots && config.module_roots.length > 0) {
    return config.module_roots;
  }

  const pnpmWorkspacePath = path.join(repoRoot, 'pnpm-workspace.yaml');
  if (fs.existsSync(pnpmWorkspacePath)) {
    const parsed = yaml.load(fs.readFileSync(pnpmWorkspacePath, 'utf8')) as
      | { packages?: string[] }
      | undefined;
    if (parsed?.packages && parsed.packages.length > 0) {
      return parsed.packages;
    }
  }

  const pkgJsonPath = path.join(repoRoot, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    const parsed = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as {
      workspaces?: string[] | { packages?: string[] };
    };
    const ws = parsed.workspaces;
    if (Array.isArray(ws)) {
      if (ws.length > 0) return ws;
    } else if (ws && typeof ws === 'object') {
      if (Array.isArray(ws.packages) && ws.packages.length > 0) {
        return ws.packages;
      }
    }
  }

  const goModPath = path.join(repoRoot, 'go.mod');
  const cargoTomlPath = path.join(repoRoot, 'Cargo.toml');
  if (fs.existsSync(goModPath) || fs.existsSync(cargoTomlPath)) {
    throw new Error(
      'Detected go.mod / Cargo.toml. MVP does not auto-discover non-JS module roots. ' +
        'Please write `module_roots` (glob list) in .cindy/project-knowledge/config.yaml.',
    );
  }

  throw new Error(
    'Could not auto-discover module roots. Please write `module_roots` ' +
      '(e.g. ["packages/*", "apps/*"]) in .cindy/project-knowledge/config.yaml.',
  );
}

/**
 * Expand a single root pattern to a list of directories that exist on disk.
 * Supports literal paths ("packages/foo") and a single trailing /* glob ("packages/*").
 * MVP keeps this simple — no recursive ** globs, no negation.
 */
function expandGlobToDirs(repoRoot: string, pattern: string): string[] {
  const normalized = pattern.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized.includes('*')) {
    const abs = path.join(repoRoot, normalized);
    return fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? [normalized] : [];
  }

  const slashIdx = normalized.lastIndexOf('/');
  const base = slashIdx >= 0 ? normalized.slice(0, slashIdx) : '.';
  const leaf = slashIdx >= 0 ? normalized.slice(slashIdx + 1) : normalized;
  const baseAbs = path.join(repoRoot, base);
  if (!fs.existsSync(baseAbs)) return [];
  const entries = fs.readdirSync(baseAbs, { withFileTypes: true });
  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!micromatch.isMatch(entry.name, leaf, { dot: false })) continue;
    matches.push(path.posix.join(base, entry.name));
  }
  return matches.sort();
}

export function kebabIdFromPath(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/\/+$/, '').replace(/\//g, '--');
}

export function defaultCoversForPath(relPath: string): string[] {
  const normalized = relPath.replace(/\\/g, '/').replace(/\/+$/, '');
  return [`${normalized}/**`];
}
