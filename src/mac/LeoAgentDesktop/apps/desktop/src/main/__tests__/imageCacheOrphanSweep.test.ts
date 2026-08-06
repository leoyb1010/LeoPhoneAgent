/**
 * Locks in the DB-reference side of startup draft image sweeping.
 */

import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const userDataDir = path.join(os.tmpdir(), `image-cache-orphan-sweep-${randomUUID()}`);

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataDir,
  },
}));

const { collectReferencedImageUrlsFromDb, collectReferencedImageUrlsFromRows } =
  await import('../imageCacheOrphanSweep');

describe('imageCacheOrphanSweep reference collection', () => {
  it('collects session xdt-image references from JSON and markdown content', () => {
    const rows = [
      {
        content: JSON.stringify({
          text: 'see image',
          images: [{ url: 'xdt-image://session-a/a.png' }],
        }),
      },
      {
        content: 'inline markdown ![x](xdt-image://session-b/b.webp)',
      },
      {
        content: JSON.stringify({
          images: [{ url: 'xdt-image://feishu-media-images/remote.png' }],
        }),
      },
    ];

    expect(collectReferencedImageUrlsFromRows(rows)).toEqual([
      'xdt-image://session-a/a.png',
      'xdt-image://session-b/b.webp',
    ]);
  });

  it('queries only visible message history when collecting startup references', () => {
    let sql = '';
    const db = {
      prepare(input: string) {
        sql = input;
        return {
          all: () => [{ content: '{"images":[{"url":"xdt-image://session-a/a.png"}]}' }],
        };
      },
    };

    expect(collectReferencedImageUrlsFromDb(db)).toEqual(['xdt-image://session-a/a.png']);
    expect(sql).toContain('rewind_at IS NULL');
    expect(sql).toContain("content LIKE '%xdt-image://%'");
  });
});
