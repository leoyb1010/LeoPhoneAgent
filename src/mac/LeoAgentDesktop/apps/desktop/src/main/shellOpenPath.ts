/** Resolve user-openable local paths without exposing media-store paths to renderer. */

import path from 'node:path';

import * as cindyMediaBlobStore from './cindy-media/blobStore.js';

/**
 * Chat history persists managed media as a stable `cindy-media://` reference.
 * Resolve that reference inside main immediately before a user-initiated OS
 * open; ordinary callers retain the existing absolute-path contract.
 */
export function resolveShellOpenPathTarget(value: string): string | null {
  if (!value) return null;
  if (path.isAbsolute(value)) return value;
  if (value.startsWith('cindy-media://')) return cindyMediaBlobStore.resolveSafe(value).absPath;
  return null;
}
