import { builtinModules } from 'node:module';
import path from 'node:path';

import Database from 'better-sqlite3';
import { build, mergeConfig, type UserConfig } from 'vite';

import dbWorkerConfig from '../../../../vite.db-worker.config';

export async function buildDbWorkerBundle(outDir: string): Promise<string> {
  const workerScriptPath = path.join(outDir, 'dbWorker.js');
  const configuredExternal = readConfiguredExternal(dbWorkerConfig as UserConfig);
  const builtinExternals = [
    ...builtinModules,
    ...builtinModules.map((moduleName) => `node:${moduleName}`),
  ];
  await build(mergeConfig(dbWorkerConfig as UserConfig, {
    root: process.cwd(),
    configFile: false,
    logLevel: 'silent',
    build: {
      copyPublicDir: false,
      emptyOutDir: true,
      minify: false,
      outDir,
      rollupOptions: {
        external: [
          ...new Set([
            ...builtinExternals,
            'electron',
            'electron/main',
            'electron/renderer',
            ...configuredExternal,
          ]),
        ],
        input: 'src/main/localDb/worker/dbWorker.ts',
        output: {
          assetFileNames: '[name].[ext]',
          chunkFileNames: '[name].js',
          entryFileNames: 'dbWorker.js',
          format: 'cjs',
          inlineDynamicImports: true,
        },
      },
    },
  }));
  return workerScriptPath;
}

export function createMigratedSmokeDb(
  dbPath: string,
  opts: { malformedHistory?: boolean; smokeName?: string } = {},
): void {
  const db = new Database(dbPath);
  try {
    db.exec(
      [
        'CREATE TABLE migration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
        opts.malformedHistory
          ? 'CREATE TABLE migration_history (seq INTEGER PRIMARY KEY);'
          : 'CREATE TABLE migration_history (seq INTEGER PRIMARY KEY, file_name TEXT NOT NULL, content_hash TEXT NOT NULL, applied_at INTEGER NOT NULL);',
        'CREATE TABLE worker_smoke (id INTEGER PRIMARY KEY, name TEXT NOT NULL);',
      ].join('\n'),
    );
    db.prepare(
      "INSERT INTO migration_meta (key, value) VALUES ('schema_version', '0')",
    ).run();
    db.prepare('INSERT INTO worker_smoke (name) VALUES (?)').run(opts.smokeName ?? 'alice');
  } finally {
    db.close();
  }
}

function readConfiguredExternal(config: UserConfig): string[] {
  const external = config.build?.rollupOptions?.external;
  return Array.isArray(external)
    ? external.filter((item): item is string => typeof item === 'string')
    : [];
}
