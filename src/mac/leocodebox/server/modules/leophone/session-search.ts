import fs from 'node:fs/promises';
import path from 'node:path';

import { expandSessionCwd, sessionCwdAllowed } from './session-workspace.js';

export const SEARCH_MAX_HITS = 40;
export const SEARCH_MAX_FILE_BYTES = 400_000;
export const SEARCH_QUERY_MAX = 80;
const SEARCH_QUERY_MIN = 2;

const SKIP_DIR = new Set([
  '.git', 'node_modules', 'dist', 'dist-server', '.desktop-build', 'release',
  '.next', 'coverage', 'Pods', 'build', '.turbo', 'vendor', 'target', '__pycache__',
]);

const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.icns', '.pdf',
  '.zip', '.gz', '.tar', '.dmg', '.app', '.exe', '.bin', '.wasm',
  '.so', '.dylib', '.class', '.jar', '.woff', '.woff2', '.ttf', '.otf',
  '.mp3', '.mp4', '.mov', '.sqlite', '.db', '.node', '.lock',
]);

export type SessionSearchHit = { file: string; line: number; text: string };

export function clipSearchLine(text: string, limit = 160): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one.length <= limit) return one;
  return `${one.slice(0, limit)}…`;
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  return buf.subarray(0, n).includes(0);
}

export async function searchSessionCwd(cwd: string, query: string): Promise<{
  query: string;
  hits: SessionSearchHit[];
  truncated: boolean;
}> {
  const root = path.resolve(expandSessionCwd(cwd));
  if (!sessionCwdAllowed(root)) throw new Error('这个目录不能搜');
  const needle = query.trim();
  if (needle.length < SEARCH_QUERY_MIN) throw new Error('至少两个字才能搜');
  if (needle.length > SEARCH_QUERY_MAX) throw new Error('要搜的字太长');
  const hits: SessionSearchHit[] = [];
  let truncated = false;
  const lowered = needle.toLowerCase();

  async function walk(dir: string): Promise<void> {
    if (hits.length >= SEARCH_MAX_HITS) {
      truncated = true;
      return;
    }
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (hits.length >= SEARCH_MAX_HITS) {
        truncated = true;
        return;
      }
      if (entry.name.startsWith('.') && entry.name !== '.env' && entry.name !== '.env.local') {
        if (entry.isDirectory()) continue;
      }
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIR.has(entry.name)) continue;
        await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (SKIP_EXT.has(ext)) continue;
      const stat = await fs.stat(abs);
      if (stat.size <= 0 || stat.size > SEARCH_MAX_FILE_BYTES) continue;
      const buf = await fs.readFile(abs);
      if (looksBinary(buf)) continue;
      const text = buf.toString('utf8');
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (hits.length >= SEARCH_MAX_HITS) {
          truncated = true;
          return;
        }
        if (!lines[i].toLowerCase().includes(lowered)) continue;
        hits.push({ file: rel.split(path.sep).join('/'), line: i + 1, text: clipSearchLine(lines[i]) });
      }
    }
  }

  await walk(root);
  return { query: needle, hits, truncated };
}
