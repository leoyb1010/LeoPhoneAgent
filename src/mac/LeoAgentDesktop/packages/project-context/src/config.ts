import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { ConfigFile } from './types.js';

export const CONTEXT_DIR = '.cindy/project-knowledge';
/**
 * 品牌迁移前的旧目录约定（2026-07-20 起硬切为 `.cindy/`）。只在命令入口做一次性
 * 搬迁（rename），除此之外代码不再识别 `.xdmaker` 路径。
 */
export const LEGACY_CONTEXT_ROOT = '.xdmaker';
export const CONTEXT_ROOT = '.cindy';
export const CONFIG_FILENAME = 'config.yaml';
export const MANIFEST_FILENAME = 'manifest.yaml';
export const MODULES_SUBDIR = 'modules';
export const CONCERNS_SUBDIR = 'concerns';
export const LOCK_FILENAME = '.lock';
/**
 * Pre-rendered TOC for session-time injection. Written by init/update/refresh after
 * manifest is updated. Consumers (e.g. apps/desktop) read this file directly instead
 * of dynamically extracting summaries from every .md at session start. Source of
 * truth for module summaries remains the `## 是什么` H2 section of each module .md;
 * this file is a derived artifact, regenerated whenever knowledge changes.
 */
export const TOC_FILENAME = 'TOC.md';

const DEFAULT_CONFIG: ConfigFile = {
  small_diff_threshold: {
    files: 5,
    lines: 200,
  },
  agent: 'claude-code',
  agent_options: {
    timeout: 300,
  },
};

export interface ResolvedPaths {
  repoRoot: string;
  contextDir: string;
  configPath: string;
  manifestPath: string;
  modulesDir: string;
  concernsDir: string;
  lockPath: string;
  tocPath: string;
}

export function resolvePaths(repoRoot: string): ResolvedPaths {
  const contextDir = path.join(repoRoot, CONTEXT_DIR);
  return {
    repoRoot,
    contextDir,
    configPath: path.join(contextDir, CONFIG_FILENAME),
    manifestPath: path.join(contextDir, MANIFEST_FILENAME),
    modulesDir: path.join(contextDir, MODULES_SUBDIR),
    concernsDir: path.join(contextDir, CONCERNS_SUBDIR),
    lockPath: path.join(contextDir, LOCK_FILENAME),
    tocPath: path.join(contextDir, TOC_FILENAME),
  };
}

/**
 * 一次性把旧 `.xdmaker/` 目录搬迁为 `.cindy/`（幂等，失败静默——调用方随后会按
 * `.cindy` 缺失的语义正常报错/初始化）。`.cindy` 已存在时逐个搬缺失的子项，
 * 搬空后删掉旧空壳；非空说明两边都有同名子项，保留旧目录让用户自行处置。
 */
export function migrateLegacyContextRoot(repoRoot: string): void {
  const oldRoot = path.join(repoRoot, LEGACY_CONTEXT_ROOT);
  const newRoot = path.join(repoRoot, CONTEXT_ROOT);
  try {
    if (!fs.existsSync(oldRoot) || !fs.statSync(oldRoot).isDirectory()) return;
    if (!fs.existsSync(newRoot)) {
      fs.renameSync(oldRoot, newRoot);
      return;
    }
    mergeDirSync(oldRoot, newRoot);
  } catch (err) {
    const newPk = path.join(newRoot, 'project-knowledge');
    const oldPk = path.join(oldRoot, 'project-knowledge');
    if (!fs.existsSync(newPk) && fs.existsSync(oldPk)) {
      throw new Error(
        `Failed to migrate ${LEGACY_CONTEXT_ROOT} → ${CONTEXT_ROOT}: ${err instanceof Error ? err.message : String(err)}. ` +
          `Please rename "${oldRoot}" to "${newRoot}" manually.`,
      );
    }
    return;
  }
  if (fs.existsSync(oldRoot)) {
    const leftover = fs.readdirSync(oldRoot);
    if (leftover.length === 0) {
      fs.rmdirSync(oldRoot);
    } else {
      throw new Error(
        `Migration incomplete: ${LEGACY_CONTEXT_ROOT} still contains conflicting entries (${leftover.join(', ')}). ` +
          `Please merge "${oldRoot}" into "${newRoot}" manually, then remove "${oldRoot}".`,
      );
    }
  }
}

function mergeDirSync(src: string, dst: string): void {
  for (const entry of fs.readdirSync(src)) {
    const from = path.join(src, entry);
    const to = path.join(dst, entry);
    if (!fs.existsSync(to)) {
      fs.renameSync(from, to);
    } else if (fs.statSync(from).isDirectory() && fs.statSync(to).isDirectory()) {
      mergeDirSync(from, to);
    }
  }
  if (fs.readdirSync(src).length === 0) fs.rmdirSync(src);
}

export function loadConfig(configPath: string): ConfigFile {
  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = (yaml.load(raw) ?? {}) as Partial<ConfigFile>;
  return mergeConfig(parsed);
}

export function mergeConfig(partial: Partial<ConfigFile>): ConfigFile {
  return {
    module_roots: partial.module_roots,
    ignore: partial.ignore,
    module_ignore: partial.module_ignore,
    small_diff_threshold: {
      ...DEFAULT_CONFIG.small_diff_threshold,
      ...(partial.small_diff_threshold ?? {}),
    },
    agent: partial.agent ?? DEFAULT_CONFIG.agent,
    agent_options: {
      ...DEFAULT_CONFIG.agent_options,
      ...(partial.agent_options ?? {}),
    },
  };
}

export function writeDefaultConfigIfMissing(configPath: string): boolean {
  if (fs.existsSync(configPath)) return false;
  const sample = `# project-context configuration. See the @cindy/project-context README for the full schema.
#
# module_roots: optional. Defaults to package-manager auto-discovery
#   (pnpm-workspace.yaml / package.json workspaces).
# module_roots:
#   - packages/*
#   - apps/*
#
# ignore: extra patterns on top of .gitignore + builtin defaults.
# ignore:
#   - apps/landing-page
#
small_diff_threshold:
  files: 5
  lines: 200

agent: claude-code
agent_options:
  timeout: 300
`;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, sample, 'utf8');
  return true;
}
