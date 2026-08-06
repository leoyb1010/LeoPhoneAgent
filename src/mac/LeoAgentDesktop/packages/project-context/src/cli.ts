#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { runInit } from './commands/init.js';
import { runUpdate } from './commands/update.js';
import { runQuery, type QueryFormat } from './commands/query.js';
import { runRefresh } from './commands/refresh.js';

const program = new Command();

program
  .name('project-context')
  .description('Agent-maintained project knowledge layer')
  .version('0.0.0');

program
  .command('init')
  .description('Build modules skeleton from package-manager workspace conventions')
  .option('--bootstrap', 'Run an initial LLM scan to propose cross-cutting concerns')
  .option('--prune', 'Delete orphan module files (those whose source dir no longer qualifies)')
  .action(async (opts: { bootstrap?: boolean; prune?: boolean }) => {
    try {
      await runInit({ bootstrap: opts.bootstrap, prune: opts.prune });
    } catch (err) {
      handleError(err);
    }
  });

program
  .command('update')
  .description('Apply git diff since last sync to relevant knowledge files')
  .option('--since <ref>', 'Override the diff base commit')
  .option('--check-only', 'Print what would change without writing')
  .action(async (opts: { since?: string; checkOnly?: boolean }) => {
    try {
      await runUpdate({ since: opts.since, checkOnly: opts.checkOnly });
    } catch (err) {
      handleError(err);
    }
  });

program
  .command('refresh [ids...]')
  .description('Rebuild knowledge bodies from current source (no diff). Pick a scope.')
  .option('--all', 'Refresh every module in the manifest (cold-start, expensive)')
  .option('--stale', 'Refresh only modules currently marked stale')
  .option('--check-only', 'Print what would be refreshed without calling LLM')
  .option('--force', 'Refresh even modules with auto_update=false')
  .option(
    '--parallel <n>',
    'Refresh up to N modules concurrently (default 1). Each worker spawns an LLM agent; 2–4 is sensible for dev, 4–6 for CI. writeManifest/writeToc still run once at the end.',
    (v) => parseInt(v, 10),
  )
  .action(
    async (
      ids: string[],
      opts: {
        all?: boolean;
        stale?: boolean;
        checkOnly?: boolean;
        force?: boolean;
        parallel?: number;
      },
    ) => {
      try {
        await runRefresh({
          ids: ids.length > 0 ? ids : undefined,
          all: opts.all,
          stale: opts.stale,
          checkOnly: opts.checkOnly,
          force: opts.force,
          parallel: opts.parallel,
        });
      } catch (err) {
        handleError(err);
      }
    },
  );

program
  .command('query')
  .description('Reverse-lookup knowledge IDs covering the given files')
  .requiredOption('--files <list>', 'Comma-separated repo-relative file paths')
  .option('--format <type>', 'Output format: ids | paths | json', 'ids')
  .action(async (opts: { files: string; format?: string }) => {
    try {
      const fmt = (opts.format ?? 'ids') as QueryFormat;
      if (!['ids', 'paths', 'json'].includes(fmt)) {
        throw new Error(`Invalid --format "${fmt}". Use ids | paths | json.`);
      }
      const files = opts.files
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean);
      if (files.length === 0) {
        throw new Error('--files must list at least one file');
      }
      await runQuery({ files, format: fmt });
    } catch (err) {
      handleError(err);
    }
  });

program.parseAsync(process.argv).catch(handleError);

function handleError(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(chalk.red(`error: ${msg}`));
  process.exit(1);
}
