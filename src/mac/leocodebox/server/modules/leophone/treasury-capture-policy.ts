import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';

import type { TreasureItem, TreasureKind } from '@/modules/database/index.js';

export function treasuryCaptureKindForMime(mime: string): TreasureKind {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'document';
}

export function treasuryCaptureSafeExtension(originalName: string): string {
  return path.extname(originalName).toLowerCase().match(/^\.[a-z0-9]{1,10}$/)?.[0] ?? '';
}

export function treasuryCaptureHttpUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

export async function treasuryCaptureVerifyPdfFile(
  filePath: string,
  expected: { byteCount: number; digest: string | null; mime: string | null },
  maxBytes = 100 * 1024 * 1024,
): Promise<boolean> {
  try {
    const metadata = await stat(filePath);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > maxBytes) return false;
    if (expected.byteCount > 0 && metadata.size !== expected.byteCount) return false;
    const looksLikePdf = expected.mime?.toLocaleLowerCase() === 'application/pdf'
      || path.extname(filePath).toLocaleLowerCase() === '.pdf';
    if (!looksLikePdf) return false;
    const handle = await open(filePath, 'r');
    try {
      const header = Buffer.alloc(Math.min(1_024, metadata.size));
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      if (!header.subarray(0, bytesRead).includes(Buffer.from('%PDF-'))) return false;
    } finally { await handle.close(); }
    if (expected.digest) {
      if (!/^[0-9a-f]{64}$/i.test(expected.digest)) return false;
      const digest = createHash('sha256');
      for await (const chunk of fs.createReadStream(filePath)) digest.update(chunk as Buffer);
      if (digest.digest('hex').toLocaleLowerCase() !== expected.digest.toLocaleLowerCase()) return false;
    }
    return true;
  } catch { return false; }
}

export function treasuryCaptureCompactItem(item: TreasureItem) {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    source_uri: item.source_uri,
    source_label: item.source_label,
    summary: item.summary,
    snippet: (item.summary || item.original_text || '').slice(0, 400),
    tags: item.tags,
    created_at: item.created_at,
    archived: item.archived,
    pinned: item.pinned,
    reading_state: item.reading_state,
    reading_progress: item.reading_progress,
    last_opened_at: item.last_opened_at,
    processing_state: item.processing_state,
    processing_error_code: item.processing_error_code,
  };
}
