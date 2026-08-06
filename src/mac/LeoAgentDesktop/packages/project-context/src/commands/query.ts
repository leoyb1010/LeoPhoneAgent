import path from 'node:path';
import { findRepoRoot } from '../git.js';
import { migrateLegacyContextRoot, resolvePaths } from '../config.js';
import { findKnowledgeIdsForFile, findEntryById, readManifest } from '../manifest.js';

export type QueryFormat = 'ids' | 'paths' | 'json';

export interface QueryOptions {
  files: string[];
  format?: QueryFormat;
  cwd?: string;
}

export interface QueryResult {
  ids: string[];
  paths: string[];
  stale: string[];
}

export async function runQuery(options: QueryOptions): Promise<QueryResult> {
  const cwd = options.cwd ?? process.cwd();
  const repoRoot = await findRepoRoot(cwd);
  migrateLegacyContextRoot(repoRoot);
  const paths = resolvePaths(repoRoot);
  const manifest = readManifest(paths.manifestPath);

  const matchedIds = new Set<string>();
  for (const file of options.files) {
    const ids = findKnowledgeIdsForFile(file, manifest);
    for (const id of ids) matchedIds.add(id);
  }

  const ids = Array.from(matchedIds).sort();
  const result: QueryResult = {
    ids,
    paths: ids
      .map((id) => findEntryById(manifest, id))
      .filter((e): e is NonNullable<typeof e> => Boolean(e))
      .map((e) => path.join(paths.contextDir, e.path.replace(/\//g, path.sep))),
    stale: ids.filter((id) => findEntryById(manifest, id)?.stale),
  };

  const fmt = options.format ?? 'ids';
  if (fmt === 'ids') {
    for (const id of result.ids) console.log(id);
  } else if (fmt === 'paths') {
    for (const p of result.paths) console.log(p);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }

  return result;
}
