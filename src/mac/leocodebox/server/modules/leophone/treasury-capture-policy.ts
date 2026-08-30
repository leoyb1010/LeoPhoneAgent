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
    processing_state: item.processing_state,
  };
}
