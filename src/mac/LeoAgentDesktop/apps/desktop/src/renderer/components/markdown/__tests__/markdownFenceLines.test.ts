/**
 * markdownFenceLines 纯函数测试 —— 围栏块行角色标注(first/body/last)。
 * 口径与 markdownImageLivePreview / markdownMermaidLivePreview 的简化
 * CommonMark 围栏规则一致。
 */
import { describe, expect, it } from 'vitest';
import { Text } from '@codemirror/state';

import {
  computeFenceLineRoles,
  type FenceLineRole,
} from '../markdownFenceLines';

function roles(docText: string): Map<number, FenceLineRole> {
  return computeFenceLineRoles(Text.of(docText.split('\n')));
}

describe('computeFenceLineRoles', () => {
  it('marks a simple closed backtick fence', () => {
    const m = roles(['prose', '```', 'a', 'b', '```', 'after'].join('\n'));
    expect(m.get(1)).toBeUndefined();
    expect(m.get(2)).toBe('first');
    expect(m.get(3)).toBe('body');
    expect(m.get(4)).toBe('body');
    expect(m.get(5)).toBe('last');
    expect(m.get(6)).toBeUndefined();
  });

  it('marks a fence with info string (```bash)', () => {
    const m = roles(['```bash', 'echo hi', '```'].join('\n'));
    expect(m.get(1)).toBe('first');
    expect(m.get(2)).toBe('body');
    expect(m.get(3)).toBe('last');
  });

  it('supports tilde fences', () => {
    const m = roles(['~~~', 'x', '~~~'].join('\n'));
    expect(m.get(1)).toBe('first');
    expect(m.get(2)).toBe('body');
    expect(m.get(3)).toBe('last');
  });

  it('handles an empty fence body', () => {
    const m = roles(['```', '```'].join('\n'));
    expect(m.get(1)).toBe('first');
    expect(m.get(2)).toBe('last');
  });

  it('leaves an unclosed fence unmarked (conservative while typing)', () => {
    const m = roles(['```', 'still typing', 'more'].join('\n'));
    expect(m.size).toBe(0);
  });

  it('stops scanning after an unclosed fence (everything below is potential body)', () => {
    const m = roles(['```', 'body?', '```', 'prose', '```unclosed', 'tail'].join('\n'));
    expect(m.get(1)).toBe('first');
    expect(m.get(3)).toBe('last');
    // 未闭合的第二个围栏之后不再标注任何行。
    expect(m.get(5)).toBeUndefined();
    expect(m.get(6)).toBeUndefined();
  });

  it('requires the closer run to be same char and at least as long', () => {
    // ```` (4) 开栏,``` (3) 不能收;之后的 ```` 才收。
    const m = roles(['````', 'code', '```', 'still code', '````'].join('\n'));
    expect(m.get(1)).toBe('first');
    expect(m.get(3)).toBe('body');
    expect(m.get(5)).toBe('last');
    // 反字符不收:~~~ 开的块 ``` 不能收。
    const m2 = roles(['~~~', '```', '~~~'].join('\n'));
    expect(m2.get(1)).toBe('first');
    expect(m2.get(2)).toBe('body');
    expect(m2.get(3)).toBe('last');
  });

  it('allows up to 3 spaces of indent, treats 4+ as plain text', () => {
    const m = roles(['   ```', 'a', '   ```'].join('\n'));
    expect(m.get(1)).toBe('first');
    expect(m.get(3)).toBe('last');
    const m2 = roles(['    ```', 'a', '    ```'].join('\n'));
    expect(m2.size).toBe(0);
  });

  it('marks back-to-back fences as separate blocks', () => {
    const m = roles(['```', 'a', '```', '```', 'b', '```'].join('\n'));
    expect(m.get(3)).toBe('last');
    expect(m.get(4)).toBe('first');
    expect(m.get(6)).toBe('last');
  });

  it('closer line may have trailing spaces but no other content', () => {
    const m = roles(['```', 'a', '```  '].join('\n'));
    expect(m.get(3)).toBe('last');
    // ```x 不是合法收栏 → 作为 body,块保持未闭合直到真正的 ```。
    const m2 = roles(['```', 'a', '``` x', '```'].join('\n'));
    expect(m2.get(3)).toBe('body');
    expect(m2.get(4)).toBe('last');
  });
});
