/**
 * fileTypeInference.ts
 * ---------------------------------------------------------------------------
 * Pure helpers for the F-FI-8 fallback type inference pipeline.
 *
 * Two signals only:
 *   1. Magic-bytes table — a small static list of fixed/structured headers
 *      covering the formats we actually care about (PNG / JPEG / GIF /
 *      WebP / PDF). No third-party dependency.
 *   2. UTF-8 sniff — TextDecoder('utf-8', { fatal: true }) over the first
 *      8 KiB; rejects anything containing a NUL byte.
 *
 * Magic check wins over UTF-8 sniff, because some binary formats (e.g. PNG)
 * happen to contain valid ASCII runs at the head.
 *
 * Lives in the renderer because:
 *   - the data source (peek IPC) is already renderer-owned,
 *   - keeping the inference in renderer means tests can stub IPC easily,
 *   - main process never touches user mime-typing logic.
 *
 * No React / no IPC inside — kept pure so the unit tests can hammer it
 * without any harness setup.
 */

import type { FileCategory } from './fileTypes';

/** Result returned by inferFileType / detectByMagicBytes. */
export interface InferredType {
  /** Lowercase extension with leading dot. */
  ext: string;
  category: FileCategory;
  mimeType: string;
}

/** Default peek size requested from the IPC layer. */
export const PEEK_BYTES = 8192;

/** Magic-bytes only need to look at the first dozen bytes. */
const MAGIC_HEAD_BYTES = 12;

/** UTF-8 sniff only inspects the leading window. */
const UTF8_SNIFF_LIMIT = 8192;

interface MagicEntry {
  matcher: (head: Uint8Array) => boolean;
  ext: string;
  category: FileCategory;
  mimeType: string;
}

/**
 * Compare a slice of `buf` starting at `offset` against the given byte sequence.
 * Returns false when the buffer is too short to hold the comparison range —
 * never throws.
 */
function bytesEqualAt(buf: Uint8Array, offset: number, expected: number[]): boolean {
  if (buf.length < offset + expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (buf[offset + i] !== expected[i]) return false;
  }
  return true;
}

/**
 * Static magic-bytes table. Function-style matcher (ADR-5) so structured
 * headers like WebP's `RIFF????WEBP` are first-class instead of a special
 * case. Adding a new format = pushing one entry; no schema change.
 */
const MAGIC_BYTES_TABLE: MagicEntry[] = [
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  {
    matcher: (h) => bytesEqualAt(h, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ext: '.png',
    category: 'image',
    mimeType: 'image/png',
  },
  // JPEG: FF D8 FF
  {
    matcher: (h) => bytesEqualAt(h, 0, [0xff, 0xd8, 0xff]),
    ext: '.jpg',
    category: 'image',
    mimeType: 'image/jpeg',
  },
  // GIF87a / GIF89a: 47 49 46 38 (37|39) 61
  {
    matcher: (h) =>
      bytesEqualAt(h, 0, [0x47, 0x49, 0x46, 0x38]) &&
      (h[4] === 0x37 || h[4] === 0x39) &&
      h[5] === 0x61,
    ext: '.gif',
    category: 'image',
    mimeType: 'image/gif',
  },
  // WebP: 52 49 46 46 ?? ?? ?? ?? 57 45 42 50
  {
    matcher: (h) =>
      bytesEqualAt(h, 0, [0x52, 0x49, 0x46, 0x46]) &&
      bytesEqualAt(h, 8, [0x57, 0x45, 0x42, 0x50]),
    ext: '.webp',
    category: 'image',
    mimeType: 'image/webp',
  },
  // PDF: 25 50 44 46 2D  ("%PDF-")
  {
    matcher: (h) => bytesEqualAt(h, 0, [0x25, 0x50, 0x44, 0x46, 0x2d]),
    ext: '.pdf',
    category: 'pdf',
    mimeType: 'application/pdf',
  },
];

/**
 * Try to identify the buffer by its leading magic bytes.
 *
 * Returns null when the buffer is shorter than the magic head window or no
 * entry matched — never throws.
 */
export function detectByMagicBytes(buffer: Uint8Array): InferredType | null {
  if (buffer.length < MAGIC_HEAD_BYTES) return null;
  const head = buffer.subarray(0, MAGIC_HEAD_BYTES);
  for (const entry of MAGIC_BYTES_TABLE) {
    if (entry.matcher(head)) {
      return { ext: entry.ext, category: entry.category, mimeType: entry.mimeType };
    }
  }
  return null;
}

/**
 * Heuristic: is the buffer plausibly a UTF-8 text file?
 *
 *   - Empty buffer → false (we cannot positively classify nothing).
 *   - Any NUL byte in the sniff window → false (treats as binary; BOM / UTF-16
 *     would have been caught by magic bytes anyway if it mattered).
 *   - TextDecoder fatal-decode failure on the sniff window → false.
 *   - Otherwise → true.
 *
 * The 8 KiB window matches the default peek size; for a larger peek we still
 * only inspect the head — encoding doesn't suddenly change at byte 8193.
 */
export function isProbablyUtf8(buffer: Uint8Array): boolean {
  if (buffer.length === 0) return false;
  const sniffLen = Math.min(buffer.length, UTF8_SNIFF_LIMIT);
  const sniff = buffer.subarray(0, sniffLen);

  for (let i = 0; i < sniff.length; i++) {
    if (sniff[i] === 0x00) return false;
  }

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sniff);
    return true;
  } catch {
    return false;
  }
}

/**
 * Top-level inference: magic bytes first, UTF-8 sniff as fallback.
 *
 *   - Empty buffer → null.
 *   - Magic match → that entry's InferredType (image / pdf).
 *   - UTF-8 plausible → `.txt` / text / text/plain.
 *   - Otherwise → null.
 *
 * Magic precedence over UTF-8 matters for formats whose head looks like
 * partly-printable ASCII (e.g. PNG with its IHDR chunk).
 */
export function inferFileType(buffer: Uint8Array): InferredType | null {
  if (buffer.length === 0) return null;

  const byMagic = detectByMagicBytes(buffer);
  if (byMagic) return byMagic;

  if (isProbablyUtf8(buffer)) {
    return { ext: '.txt', category: 'text', mimeType: 'text/plain' };
  }

  return null;
}

/**
 * Decode the base64 payload returned by the peek IPC into a Uint8Array
 * suitable for the inference helpers. Uses the standard `atob` available in
 * both the renderer (browser globals) and the Vitest jsdom environment.
 */
export function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}
