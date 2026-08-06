import { describe, expect, it } from 'vitest';

import { tokenizeThinkingText } from '../thinkingText.js';

describe('tokenizeThinkingText', () => {
  it('removes paired Codex strong markers and preserves inline code semantics', () => {
    expect(tokenizeThinkingText('**Inspecting files** with `git status`')).toEqual([
      { kind: 'strong', value: 'Inspecting files' },
      { kind: 'text', value: ' with ' },
      { kind: 'code', value: 'git status' },
    ]);
  });

  it('keeps malformed, escaped, glob, and triple-star markers literal', () => {
    for (const content of [
      '**unfinished',
      String.raw`\**escaped**`,
      '**/*.ts',
      '***nested***',
      '2 ** 3',
    ]) {
      expect(tokenizeThinkingText(content)).toEqual([{ kind: 'text', value: content }]);
    }
  });

  it('supports matching backtick runs without interpreting unrelated Markdown', () => {
    expect(tokenizeThinkingText('Use ``a ` b`` and [docs](https://example.com)')).toEqual([
      { kind: 'text', value: 'Use ' },
      { kind: 'code', value: 'a ` b' },
      { kind: 'text', value: ' and [docs](https://example.com)' },
    ]);
  });
});
