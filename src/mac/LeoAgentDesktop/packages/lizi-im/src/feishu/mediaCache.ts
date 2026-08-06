/**
 * feishu/mediaCache.ts
 * ---------------------------------------------------------------------------
 * Resolve an `xdt-image://feishu-media-{images,files}/<filename>` URL back to
 * its absolute path inside `host.paths.feishuMediaDir`.
 *
 * The URL convention is fixed by the host's feishu media wiring
 * (see the host's mcp-integrations layer). @cindy/im replicates the
 * resolution rather than depending on `imageCacheStore` so it stays a pure
 * package.
 *
 * Safety: the resolved path MUST live under `mediaDir`; ../-style traversal
 * throws.
 */

import path from 'node:path';

const HOST_IMAGES = 'feishu-media-images';
const HOST_FILES = 'feishu-media-files';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

export interface ResolvedMedia {
  absPath: string;
  mimeType: string;
}

export function resolveFeishuMediaUrl(
  url: string,
  mediaDir: string,
): ResolvedMedia {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid xdt-image URL: ${url}`);
  }

  if (parsed.protocol !== 'xdt-image:') {
    throw new Error(`unexpected protocol: ${parsed.protocol}`);
  }

  const host = parsed.host;
  const filename = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  if (!filename) throw new Error(`missing filename in URL: ${url}`);

  let subdir: string;
  if (host === HOST_IMAGES) subdir = 'images';
  else if (host === HOST_FILES) subdir = 'files';
  else throw new Error(`unknown xdt-image host: ${host}`);

  const absPath = path.resolve(mediaDir, subdir, filename);
  const mediaRoot = path.resolve(mediaDir);
  if (!absPath.startsWith(mediaRoot + path.sep)) {
    throw new Error(`path traversal blocked: ${absPath}`);
  }

  const ext = path.extname(filename).toLowerCase();
  const mimeType = MIME_BY_EXT[ext] ?? 'application/octet-stream';
  return { absPath, mimeType };
}
