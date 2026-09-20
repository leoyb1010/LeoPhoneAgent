import fs from 'node:fs';
import path from 'node:path';

import { expandSessionCwd, sessionCwdAllowed } from './session-workspace.js';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
const MAX_IMAGES = 3;
const MAX_BYTES = 4 * 1024 * 1024;

export function imagePathsInPrompt(prompt?: string | null): string[] {
  const text = String(prompt ?? '');
  const found: string[] = [];
  const seen = new Set<string>();
  const re = /(?:^|[\s`'"(])((?:~\/|\/|\.\.?\/)?(?:[^\s`'")]+\/)*[^\s`'")]+\.(?:png|jpe?g|gif|webp))\b/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const raw = String(match[1] ?? '').replace(/[.,;:]+$/, '');
    if (!IMAGE_EXT.test(raw) || seen.has(raw)) continue;
    if (raw.startsWith('http://') || raw.startsWith('https://')) continue;
    seen.add(raw);
    found.push(raw);
  }
  return found;
}

export function resolveSessionImagePath(file: string, cwd: string): string | null {
  const root = path.resolve(expandSessionCwd(cwd));
  if (!sessionCwdAllowed(root)) return null;
  const raw = file.trim();
  if (!raw) return null;
  const abs = path.resolve(raw.startsWith('/') || raw.startsWith('~/') ? expandSessionCwd(raw) : path.join(root, raw));
  if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) return null;
  if (!sessionCwdAllowed(abs)) return null;
  return abs;
}

export function sessionImagesFromPrompt(prompt: string, cwd: string): Array<{ type: 'image'; data: string; mimeType: string }> {
  const out: Array<{ type: 'image'; data: string; mimeType: string }> = [];
  for (const raw of imagePathsInPrompt(prompt)) {
    if (out.length >= MAX_IMAGES) break;
    const abs = resolveSessionImagePath(raw, cwd);
    if (!abs) continue;
    const mime = MIME[path.extname(abs).toLowerCase()];
    if (!mime) continue;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size <= 0 || st.size > MAX_BYTES) continue;
      out.push({ type: 'image', data: fs.readFileSync(abs).toString('base64'), mimeType: mime });
    } catch {
      // 字还在输入栏里，文件没了就跳过，不挡这一句发出去。
    }
  }
  return out;
}

export function attachSessionImages<T extends Record<string, unknown>>(frame: T, prompt: string, cwd: string): T {
  const images = sessionImagesFromPrompt(prompt, cwd);
  if (!images.length) return frame;
  return { ...frame, images };
}
