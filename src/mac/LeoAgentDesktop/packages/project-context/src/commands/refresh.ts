import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { findRepoRoot } from '../git.js';
import { loadConfig, migrateLegacyContextRoot, resolvePaths } from '../config.js';
import { readKnowledgeFile, writeKnowledgeFile } from '../knowledge.js';
import { readManifest, rebuildManifestFromDisk, writeManifest } from '../manifest.js';
import { makeAdapter } from '../adapters/factory.js';
import { writeToc } from '../toc.js';
import type { ManifestEntry } from '../types.js';

export interface RefreshOptions {
  ids?: string[];
  all?: boolean;
  stale?: boolean;
  checkOnly?: boolean;
  force?: boolean;
  cwd?: string;
  /**
   * Number of modules to refresh concurrently. Default 1 (sequential). Each
   * worker spawns its own LLM agent process — set with care:
   *   - too high → may trip Anthropic RPM/TPM limits, exhaust local memory
   *     (~200MB per claude headless process), and saturate disk IO from
   *     concurrent Read/Glob/Grep over the same repo
   *   - sensible range: 2–4 for desktop dev, 4–6 on a beefy CI runner
   * writeManifest + writeToc still run once at the end (after all workers
   * finish), so no manifest/TOC write contention.
   */
  parallel?: number;
}

export interface RefreshResult {
  refreshed: string[];
  skipped: { id: string; reason: string }[];
  failed: { id: string; error: string }[];
}

const REFRESH_INSTRUCTION = `
You are filling in (or rebuilding) a project-knowledge file used as context for
future AI agent sessions. The goal: a concise, accurate description of what this
module/concern is, its key abstractions, its boundaries, and what NOT to do.

Write for an LLM reader, not a human. Bias to:
- precise file/symbol references with paths
- explicit module boundaries (what this depends on / is depended on by)
- pitfalls and reasons (why X is done that way) that aren't obvious from code

Avoid:
- marketing language
- restating the obvious
- speculation about future plans
`.trim();

export async function runRefresh(options: RefreshOptions): Promise<RefreshResult> {
  const cwd = options.cwd ?? process.cwd();
  const repoRoot = await findRepoRoot(cwd);
  migrateLegacyContextRoot(repoRoot);
  const paths = resolvePaths(repoRoot);

  if (!fs.existsSync(paths.contextDir)) {
    throw new Error(
      `No .cindy/project-knowledge/ found in ${repoRoot}. Run \`project-context init\` first.`,
    );
  }

  const config = loadConfig(paths.configPath);
  const manifest = readManifest(paths.manifestPath);
  if (manifest.entries.length === 0) {
    throw new Error('Manifest is empty. Run `project-context init` first.');
  }

  const targets = pickTargets(manifest.entries, options);
  if (targets.length === 0) {
    console.log(chalk.dim('refresh: no targets matched. Nothing to do.'));
    return { refreshed: [], skipped: [], failed: [] };
  }

  // Lock against concurrent refresh/update.
  const lockHandle = tryAcquireLock(paths.lockPath);
  if (!lockHandle) {
    console.log(chalk.dim('refresh: another instance is running (lock held). Skipping.'));
    return { refreshed: [], skipped: [], failed: [] };
  }

  console.log(chalk.bold(`project-context refresh`));
  console.log(`  targets: ${targets.length} (${describeScope(options)})`);
  if (options.checkOnly) {
    console.log(chalk.dim('  (check-only: no LLM calls, no files written)'));
    for (const t of targets) console.log(`    ? ${t.id}${t.stale ? chalk.yellow(' [stale]') : ''}`);
    releaseLock(paths.lockPath, lockHandle);
    return {
      refreshed: [],
      skipped: targets.map((t) => ({ id: t.id, reason: 'check-only' })),
      failed: [],
    };
  }

  const adapter = makeAdapter(config);
  const refreshed: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const failed: { id: string; error: string }[] = [];

  const concurrency = Math.max(1, options.parallel ?? 1);
  let completed = 0;

  const refreshOne = async (entry: ManifestEntry): Promise<void> => {
    const filePath = path.join(paths.contextDir, entry.path.replace(/\//g, path.sep));
    const knowledge = readKnowledgeFile(filePath);

    if (knowledge.frontmatter.auto_update === false && !options.force) {
      skipped.push({ id: entry.id, reason: 'auto_update=false' });
      completed += 1;
      console.log(chalk.dim(`  [${completed}/${targets.length}] ${entry.id}  skipped (read-only)`));
      return;
    }

    console.log(chalk.cyan(`  [start] ${entry.id}`));
    const startedAt = Date.now();
    try {
      const newBody = await adapter.refreshKnowledge({
        oldContent: fs.readFileSync(filePath, 'utf8'),
        instruction: REFRESH_INSTRUCTION,
        contextHint: buildContextHint(entry),
        cwd: repoRoot,
      });
      knowledge.frontmatter.stale = false;
      knowledge.frontmatter.stale_reason = null;
      knowledge.frontmatter.last_synced_at = new Date().toISOString();
      // last_synced_commit kept as-is — refresh is structural, not commit-driven.
      writeKnowledgeFile(filePath, knowledge.frontmatter, newBody);
      refreshed.push(entry.id);
      const tookMs = Date.now() - startedAt;
      completed += 1;
      console.log(chalk.green(`  [${completed}/${targets.length}] ${entry.id}  done (${(tookMs / 1000).toFixed(1)}s)`));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push({ id: entry.id, error: msg });
      completed += 1;
      console.log(chalk.red(`  [${completed}/${targets.length}] ${entry.id}  failed: ${msg.split('\n')[0]}`));
      // Mark stale so the next attempt knows this needs another try.
      knowledge.frontmatter.stale = true;
      knowledge.frontmatter.stale_reason = `refresh failed: ${msg.split('\n')[0]}`;
      writeKnowledgeFile(filePath, knowledge.frontmatter, knowledge.body);
    }
  };

  try {
    if (concurrency > 1) {
      console.log(chalk.dim(`  (parallel=${concurrency})`));
    }
    await runWithConcurrency(targets, refreshOne, concurrency);

    writeManifest(paths.manifestPath, rebuildManifestFromDisk(paths));
    writeToc(paths);
  } finally {
    releaseLock(paths.lockPath, lockHandle);
  }

  // Summary.
  console.log('');
  console.log(
    `  ${chalk.green(`refreshed: ${refreshed.length}`)}, ` +
      `${chalk.dim(`skipped: ${skipped.length}`)}, ` +
      `${chalk.red(`failed: ${failed.length}`)}`,
  );
  if (skipped.length > 0) {
    for (const s of skipped) console.log(chalk.dim(`    s ${s.id}  (${s.reason})`));
  }
  if (failed.length > 0) {
    for (const f of failed) console.log(chalk.red(`    x ${f.id}  ${f.error.split('\n')[0]}`));
  }

  return { refreshed, skipped, failed };
}

function pickTargets(entries: ManifestEntry[], options: RefreshOptions): ManifestEntry[] {
  const requested = countScopes(options);
  if (requested === 0) {
    throw new Error(
      'refresh: must specify one of: <id>, --all, --stale (mutually exclusive).',
    );
  }
  if (requested > 1) {
    throw new Error('refresh: --all, --stale, and <id> are mutually exclusive.');
  }
  if (options.all) return entries;
  if (options.stale) return entries.filter((e) => e.stale);
  // ids path
  const idSet = new Set(options.ids ?? []);
  const matched = entries.filter((e) => idSet.has(e.id));
  const missing = [...idSet].filter((id) => !matched.find((e) => e.id === id));
  if (missing.length > 0) {
    throw new Error(`refresh: unknown id(s): ${missing.join(', ')}`);
  }
  return matched;
}

function countScopes(options: RefreshOptions): number {
  let n = 0;
  if (options.ids && options.ids.length > 0) n += 1;
  if (options.all) n += 1;
  if (options.stale) n += 1;
  return n;
}

function describeScope(options: RefreshOptions): string {
  if (options.all) return 'scope=all';
  if (options.stale) return 'scope=stale';
  return `scope=ids:${(options.ids ?? []).join(',')}`;
}

function buildContextHint(entry: ManifestEntry): string {
  return [
    `module id: ${entry.id}`,
    `type: ${entry.type}`,
    `covers (relative to repo root):`,
    ...entry.covers.map((c) => `  - ${c}`),
    `manifest entry path: ${entry.path}`,
  ].join('\n');
}

/**
 * Run `worker(item)` over `items` with at most `concurrency` in-flight at once.
 * Errors from individual workers are NOT thrown — `refreshOne` already catches
 * its own errors and records them into refreshed/failed/skipped, so this just
 * needs to keep the pool full and wait for completion. Order of completion is
 * non-deterministic across workers (intentional: see [start]/[N/total] logs).
 */
async function runWithConcurrency<T>(
  items: T[],
  worker: (item: T) => Promise<void>,
  concurrency: number,
): Promise<void> {
  if (concurrency <= 1 || items.length <= 1) {
    for (const item of items) await worker(item);
    return;
  }
  let cursor = 0;
  const pump = async (): Promise<void> => {
    while (cursor < items.length) {
      const idx = cursor++;
      await worker(items[idx]!);
    }
  };
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, () => pump());
  await Promise.all(lanes);
}

function tryAcquireLock(lockPath: string): number | null {
  try {
    return fs.openSync(lockPath, 'wx');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return null;
    throw err;
  }
}

function releaseLock(lockPath: string, handle: number | null): void {
  if (handle == null) return;
  try {
    fs.closeSync(handle);
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* ignore */
  }
}
