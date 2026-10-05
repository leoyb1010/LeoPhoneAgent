import { HttpError } from "../errors.js";

/** Page the authorized projection; internal candidate cursors never cross the API. */
export async function authorizedIssuePage<T extends { id: string }>(input: {
  limit: number;
  offset: number;
  afterId?: string;
  keyset: boolean;
  read: (cursor: { offset: number; afterId?: string; limit: number }) => Promise<T[]>;
  authorize: (rows: T[]) => Promise<T[]>;
  batchSize?: number;
  maxCandidates?: number;
  maxDurationMs?: number;
  now?: () => number;
  signal?: AbortSignal;
}): Promise<T[]> {
  const now = input.now ?? (() => performance.now());
  const started = now();
  const maxCandidates = input.maxCandidates ?? 4000;
  const maxDurationMs = input.maxDurationMs ?? 15000;
  const batchSize = input.batchSize ?? 100;
  const rows: T[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let scanned = 0;
  let rawOffset = 0;
  let rawAfterId = input.afterId;
  const exhausted = () => { throw new HttpError(503, "Resource limit reached; retry later or narrow the query."); };
  const checkTime = () => { input.signal?.throwIfAborted(); if (now() - started > maxDurationMs) exhausted(); };

  while (rows.length < input.limit) {
    checkTime();
    if (scanned >= maxCandidates) exhausted();
    const limit = Math.min(batchSize, maxCandidates - scanned);
    const candidates = await input.read({ offset: rawOffset, afterId: rawAfterId, limit });
    scanned += candidates.length;
    if (scanned > maxCandidates) exhausted();
    checkTime();
    const allowed = await input.authorize(candidates);
    checkTime();
    for (const row of allowed) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      if (skipped < input.offset) { skipped++; continue; }
      rows.push(row);
      if (rows.length === input.limit) return rows;
    }
    if (candidates.length < limit) return rows;
    if (input.keyset) {
      const lastId = candidates[candidates.length - 1]!.id;
      if (rawAfterId !== undefined && lastId.toLowerCase() <= rawAfterId.toLowerCase()) exhausted();
      rawAfterId = lastId;
    } else { rawOffset += candidates.length; }
  }
  return rows;
}
