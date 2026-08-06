import { describe, expect, it } from 'vitest';

import {
  ATTACH_OSS_SCHEME,
  buildAttachmentOssRef,
  buildLegacyAttachmentOssRef,
  isAttachmentOssRef,
  LEGACY_ATTACH_OSS_SCHEME,
  parseAttachmentOssRef,
} from '../attachmentOssRef.js';

const SHA256 = 'a'.repeat(64);

describe('attachment OSS reference contract', () => {
  it('round-trips integrity metadata and UTF-8 filenames', () => {
    const ref = {
      ossKey: 'cindy/device-link/user/object.png',
      mimeType: 'image/png',
      originalName: '截图 1.png',
      size: 42,
      sha256: SHA256,
    };
    const encoded = buildAttachmentOssRef(ref);
    expect(encoded.startsWith(`${ATTACH_OSS_SCHEME}://m/`)).toBe(true);
    expect(parseAttachmentOssRef(encoded)).toEqual(ref);
  });

  it('accepts legacy references without integrity metadata', () => {
    const encoded = buildAttachmentOssRef({ ossKey: 'legacy/file.pdf' });
    expect(parseAttachmentOssRef(encoded)).toEqual({
      ossKey: 'legacy/file.pdf',
      mimeType: undefined,
      originalName: undefined,
    });
  });

  it('parses the pre-brand legacy scheme permanently', () => {
    const current = buildAttachmentOssRef({ ossKey: 'legacy/in-flight.pdf' });
    const legacy = current.replace(`${ATTACH_OSS_SCHEME}://`, `${LEGACY_ATTACH_OSS_SCHEME}://`);
    expect(isAttachmentOssRef(legacy)).toBe(true);
    expect(parseAttachmentOssRef(legacy)).toMatchObject({ ossKey: 'legacy/in-flight.pdf' });
  });

  it('can emit the legacy scheme during a mixed-client rollout', () => {
    const encoded = buildLegacyAttachmentOssRef({ ossKey: 'rollout/file.pdf' });
    expect(encoded.startsWith(`${LEGACY_ATTACH_OSS_SCHEME}://m/`)).toBe(true);
    expect(parseAttachmentOssRef(encoded)).toMatchObject({ ossKey: 'rollout/file.pdf' });
  });

  it('rejects partial, malformed, or uppercase integrity metadata', () => {
    expect(() => buildAttachmentOssRef({ ossKey: 'k', size: 1 })).toThrow(/size and sha256/);
    expect(() => buildAttachmentOssRef({ ossKey: 'k', size: 0, sha256: SHA256 })).toThrow(
      /size and sha256/,
    );
    expect(() =>
      buildAttachmentOssRef({
        ossKey: 'k',
        size: 1,
        sha256: SHA256.toUpperCase(),
      }),
    ).toThrow(/size and sha256/);

    const partial = `${ATTACH_OSS_SCHEME}://m/${base64Url(JSON.stringify({ ossKey: 'k', size: 1 }))}`;
    expect(parseAttachmentOssRef(partial)).toBeNull();
    expect(parseAttachmentOssRef(`${ATTACH_OSS_SCHEME}://m/!!!`)).toBeNull();
  });

  it('recognizes only the attachment scheme', () => {
    expect(isAttachmentOssRef(buildAttachmentOssRef({ ossKey: 'k' }))).toBe(true);
    expect(isAttachmentOssRef('xdt-image://session/a.png')).toBe(false);
  });
});

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}
