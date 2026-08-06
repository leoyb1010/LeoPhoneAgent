import { describe, expect, it } from 'vitest';
import { stripTrailingPathSeparators } from '../pathText.js';

describe('stripTrailingPathSeparators', () => {
  it('removes one or more trailing / or \\ separators', () => {
    expect(stripTrailingPathSeparators('a/b/')).toBe('a/b');
    expect(stripTrailingPathSeparators('a/b///')).toBe('a/b');
    expect(stripTrailingPathSeparators('a\\b\\')).toBe('a\\b');
    expect(stripTrailingPathSeparators('a/b\\/\\')).toBe('a/b');
  });

  it('leaves strings without trailing separators untouched', () => {
    expect(stripTrailingPathSeparators('a/b')).toBe('a/b');
    expect(stripTrailingPathSeparators('')).toBe('');
    expect(stripTrailingPathSeparators('file.ts')).toBe('file.ts');
  });

  it('returns empty string for all-separator input', () => {
    expect(stripTrailingPathSeparators('///')).toBe('');
    expect(stripTrailingPathSeparators('\\')).toBe('');
  });

  it('stays equivalent to the legacy trailing separator strip cases without keeping the regex oracle', () => {
    const cases: Array<[input: string, expected: string]> = [
      ['', ''],
      ['/', ''],
      ['a', 'a'],
      ['a/', 'a'],
      ['a//', 'a'],
      ['/a/b//', '/a/b'],
      ['C:\\Users\\', 'C:\\Users'],
      ['x\\/', 'x'],
      ['/'.repeat(50), ''],
    ];
    for (const [input, expected] of cases) {
      expect(stripTrailingPathSeparators(input)).toBe(expected);
    }
  });
});
