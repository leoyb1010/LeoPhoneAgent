/**
 * 跨 agent 文本中"claude code" ↔ "codex" 的术语互换。
 *
 * 单词边界感知（前后都不是 word char），保留首字母大小写。
 * 多变体按长度倒序：preserve "claude code" > "claude-code" > "claude" 优先级。
 */

import type { MigrationDirection } from '../types.js';

const WORD_CHAR = /[A-Za-z0-9_]/;

const CLAUDE_VARIANTS = ['claude code', 'claude-code', 'claude_code', 'claudecode', 'claude'];
const CODEX_VARIANTS = ['codex'];

function replaceTermsCaseInsensitive(input: string, variants: string[], replacement: string): string {
  const ordered = [...variants].sort((a, b) => b.length - a.length);
  let out = '';
  let i = 0;
  while (i < input.length) {
    let matched = false;
    for (const v of ordered) {
      if (i + v.length > input.length) continue;
      if (i > 0 && WORD_CHAR.test(input[i - 1])) continue;
      const slice = input.slice(i, i + v.length);
      if (slice.toLowerCase() !== v.toLowerCase()) continue;
      const after = input[i + v.length];
      if (after && WORD_CHAR.test(after)) continue;

      const firstCharIsUpper = /[A-Z]/.test(slice[0]);
      const replaced = firstCharIsUpper
        ? replacement[0].toUpperCase() + replacement.slice(1)
        : replacement;
      out += replaced;
      i += v.length;
      matched = true;
      break;
    }
    if (!matched) {
      out += input[i];
      i += 1;
    }
  }
  return out;
}

export function rewriteTerms(content: string, direction: MigrationDirection): string {
  if (direction === 'to-codex') {
    return replaceTermsCaseInsensitive(content, CLAUDE_VARIANTS, 'codex');
  }
  return replaceTermsCaseInsensitive(content, CODEX_VARIANTS, 'claude code');
}
