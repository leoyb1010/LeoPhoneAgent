/**
 * Startup orphan sweep for unsent draft images.
 *
 * The renderer composer draft is intentionally in-memory only, but image bytes
 * for an existing session live on disk. On a new process start any file still
 * marked as `draft` and not referenced by SQLite message history is no longer
 * reachable by the UI, so it can be removed.
 */

import * as imageCacheStore from './imageCacheStore.js';
import type { DbClient } from './localDb/client/DbClient.js';

type RawDbLike = {
  prepare(sql: string): {
    all(): unknown[];
  };
};

type MessageContentRow = {
  content: unknown;
};

const REFERENCED_IMAGE_ROWS_SQL = `SELECT content
   FROM messages
  WHERE rewind_at IS NULL
    AND content LIKE '%xdt-image://%'`;

export interface StartupDraftImageSweepResult extends imageCacheStore.SweepDraftImagesResult {
  referencedUrls: number;
}

function isMessageContentRow(row: unknown): row is MessageContentRow {
  return !!row && typeof row === 'object' && 'content' in row;
}

export function collectReferencedImageUrlsFromRows(rows: unknown[]): string[] {
  const urls = new Set<string>();
  for (const row of rows) {
    if (!isMessageContentRow(row)) continue;
    for (const url of imageCacheStore.collectSessionImageUrls(row.content)) {
      urls.add(url);
    }
  }
  return [...urls];
}

export function collectReferencedImageUrlsFromDb(db: RawDbLike): string[] {
  const rows = db
    .prepare(REFERENCED_IMAGE_ROWS_SQL)
    .all();
  return collectReferencedImageUrlsFromRows(rows);
}

export async function collectReferencedImageUrlsFromDbClient(
  dbClient: Pick<DbClient, 'query'>,
): Promise<string[]> {
  const rows = await dbClient.query<MessageContentRow>(REFERENCED_IMAGE_ROWS_SQL);
  return collectReferencedImageUrlsFromRows(rows);
}

export async function sweepStartupDraftImages(params: {
  db?: RawDbLike;
  dbClient?: Pick<DbClient, 'query'>;
  processStartedAtMs: number;
}): Promise<StartupDraftImageSweepResult> {
  const referencedUrls = params.dbClient
    ? await collectReferencedImageUrlsFromDbClient(params.dbClient)
    : collectReferencedImageUrlsFromDb(params.db!);
  const sweep = await imageCacheStore.sweepDraftImages({
    referencedUrls,
    createdBeforeMs: params.processStartedAtMs,
  });
  return { ...sweep, referencedUrls: referencedUrls.length };
}
