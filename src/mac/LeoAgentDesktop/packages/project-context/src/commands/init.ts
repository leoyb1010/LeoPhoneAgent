import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { findRepoRoot, getCurrentHead } from '../git.js';
import { loadConfig, migrateLegacyContextRoot, resolvePaths, writeDefaultConfigIfMissing } from '../config.js';
import { discoverModules, defaultCoversForPath } from '../discovery.js';
import { createSkeletonBody, makeFrontmatter, writeKnowledgeFile } from '../knowledge.js';
import { rebuildManifestFromDisk, writeManifest } from '../manifest.js';
import { writeToc } from '../toc.js';

export interface InitOptions {
  bootstrap?: boolean;
  prune?: boolean;
  cwd?: string;
}

export interface InitResult {
  created: string[];
  skipped: string[];
  orphans: string[];
  pruned: string[];
  configCreated: boolean;
  bootstrapAttempted: boolean;
}

export async function runInit(options: InitOptions = {}): Promise<InitResult> {
  const cwd = options.cwd ?? process.cwd();
  const repoRoot = await findRepoRoot(cwd);
  migrateLegacyContextRoot(repoRoot);
  const paths = resolvePaths(repoRoot);

  fs.mkdirSync(paths.contextDir, { recursive: true });
  fs.mkdirSync(paths.modulesDir, { recursive: true });
  fs.mkdirSync(paths.concernsDir, { recursive: true });

  const configCreated = writeDefaultConfigIfMissing(paths.configPath);
  const config = loadConfig(paths.configPath);
  const modules = discoverModules(repoRoot, config);

  if (modules.length === 0) {
    throw new Error(
      'Discovery returned 0 modules. Check pnpm-workspace.yaml / package.json workspaces ' +
        'or set `module_roots` in .cindy/project-knowledge/config.yaml.',
    );
  }

  const head = await getCurrentHead(repoRoot);
  const created: string[] = [];
  const skipped: string[] = [];

  const discoveredIds = new Set(modules.map((m) => m.id));

  for (const mod of modules) {
    const filePath = path.join(paths.modulesDir, `${mod.id}.md`);
    if (fs.existsSync(filePath)) {
      skipped.push(mod.id);
      continue;
    }
    const frontmatter = makeFrontmatter({
      id: mod.id,
      type: 'module',
      covers: defaultCoversForPath(mod.path),
      head,
    });
    const body = createSkeletonBody(mod.id, 'module');
    writeKnowledgeFile(filePath, frontmatter, body);
    created.push(mod.id);
  }

  // Detect orphan modules: .md files on disk whose ID is no longer in discovery.
  // Common cause: a previously-discovered dir was deleted, or the source-files
  // heuristic now rejects it (e.g. *-bin packages).
  const orphans: string[] = [];
  if (fs.existsSync(paths.modulesDir)) {
    for (const file of fs.readdirSync(paths.modulesDir).filter((f) => f.endsWith('.md'))) {
      const id = file.replace(/\.md$/, '');
      if (!discoveredIds.has(id)) orphans.push(id);
    }
  }

  const pruned: string[] = [];
  if (options.prune && orphans.length > 0) {
    for (const id of orphans) {
      fs.rmSync(path.join(paths.modulesDir, `${id}.md`), { force: true });
      pruned.push(id);
    }
  }

  const entries = rebuildManifestFromDisk(paths);
  writeManifest(paths.manifestPath, entries);
  const tocResult = writeToc(paths);

  // Console summary.
  console.log(chalk.bold(`project-context init`));
  console.log(`  repo root: ${repoRoot}`);
  console.log(`  discovered modules: ${modules.length}`);
  console.log(
    `  ${chalk.green(`created: ${created.length}`)}, ${chalk.dim(`skipped: ${skipped.length}`)}` +
      (orphans.length > 0 ? `, ${chalk.yellow(`orphans: ${orphans.length}`)}` : ''),
  );
  if (created.length > 0) {
    for (const id of created) console.log(`    + ${id}`);
  }
  if (skipped.length > 0) {
    for (const id of skipped) console.log(chalk.dim(`    = ${id}  (already exists)`));
  }
  if (orphans.length > 0) {
    for (const id of orphans) {
      const note = pruned.includes(id) ? chalk.red('(pruned)') : chalk.yellow('(orphan)');
      console.log(`    o ${id}  ${note}`);
    }
    if (!options.prune) {
      console.log(
        chalk.dim(
          '  hint: rerun with --prune to remove orphan module files, or keep them ' +
            'and set `auto_update: false` in their frontmatter to freeze.',
        ),
      );
    }
  }
  if (configCreated) {
    console.log(chalk.green(`  wrote default ${path.relative(repoRoot, paths.configPath)}`));
  }
  console.log(`  manifest: ${path.relative(repoRoot, paths.manifestPath)}`);
  console.log(
    `  toc:      ${path.relative(repoRoot, paths.tocPath)}  (${tocResult.entries} entries${
      tocResult.truncated ? ', truncated' : ''
    })`,
  );

  let bootstrapAttempted = false;
  if (options.bootstrap) {
    bootstrapAttempted = true;
    console.log(
      chalk.yellow(
        '\n  --bootstrap: not implemented in MVP runtime path yet. ' +
          'Skipping bootstrap; you can fill modules manually or wait for Phase 2.',
      ),
    );
    // Bootstrap implementation is deferred. The hook is here so that
    // the CLI accepts the flag without erroring; concerns/ scan + LLM prompting will
    // land in the next iteration.
  }

  return { created, skipped, orphans, pruned, configCreated, bootstrapAttempted };
}
