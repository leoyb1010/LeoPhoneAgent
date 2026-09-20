import fs from 'node:fs';
import path from 'node:path';

import { expandSessionCwd, sessionCwdAllowed } from './session-workspace.js';

const CITE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|txt|css|html|py|go|rs|swift|kt|java|yml|yaml|toml|sh|sql)$/i;
const MAX_FILES = 3;
const MAX_BYTES = 80_000;

export function citePathsInPrompt(prompt?: string | null): string[] {
  const text = String(prompt ?? '');
  const found: string[] = [];
  const seen = new Set<string>();
  const re = /(?:^|[\s`'"(])((?:~\/|\/|\.\.?\/)?(?:[^\s`'")]+\/)*[^\s`'")]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|txt|css|html|py|go|rs|swift|kt|java|yml|yaml|toml|sh|sql))\b/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const raw = String(match[1] ?? '').replace(/[.,;:]+$/, '');
    if (!CITE_EXT.test(raw) || seen.has(raw)) continue;
    if (raw.startsWith('http://') || raw.startsWith('https://')) continue;
    seen.add(raw);
    found.push(raw);
  }
  return found;
}

export function resolveSessionCitePath(file: string, cwd: string): string | null {
  const root = path.resolve(expandSessionCwd(cwd));
  if (!sessionCwdAllowed(root)) return null;
  const raw = file.trim();
  if (!raw) return null;
  const abs = path.resolve(raw.startsWith('/') || raw.startsWith('~/') ? expandSessionCwd(raw) : path.join(root, raw));
  if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) return null;
  if (!sessionCwdAllowed(abs)) return null;
  return abs;
}

export function sessionCiteText(prompt: string, cwd: string): string {
  const root = path.resolve(expandSessionCwd(cwd));
  const blocks: string[] = [];
  for (const raw of citePathsInPrompt(prompt)) {
    if (blocks.length >= MAX_FILES) break;
    const abs = resolveSessionCitePath(raw, cwd);
    if (!abs) continue;
    if (!CITE_EXT.test(abs)) continue;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size <= 0 || st.size > MAX_BYTES) continue;
      const body = fs.readFileSync(abs, 'utf8');
      if (!body || body.includes('\u0000')) continue;
      const name = abs.startsWith(`${root}${path.sep}`) ? abs.slice(root.length + 1) : path.basename(abs);
      blocks.push(`\`\`\`${name}\n${body.replace(/\s+$/, '')}\n\`\`\``);
    } catch {
      // 路径还在输入栏里，文件没了就跳过，不挡这一句发出去。
    }
  }
  return blocks.join('\n\n');
}

export function attachSessionCites<T extends Record<string, unknown>>(frame: T, prompt: string, cwd: string): T {
  const body = sessionCiteText(prompt, cwd);
  if (!body) return frame;
  const message = String(frame.message ?? prompt);
  return { ...frame, message: `${message}\n\n${body}` };
}
