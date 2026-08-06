import { describe, expect, it } from 'vitest';
import { stripTrailingPathSeparators } from '../../shared/pathText';

// Frozen [input, expected] table mirroring what the old `replace(/[\\/]+$/, '')` produced.
// Literals (not a regex oracle) so this regression test never reintroduces the
// js/polynomial-redos pattern it exists to eliminate.
const CASES: ReadonlyArray<readonly [input: string, expected: string]> = [
  ['', ''],
  ['/', ''],
  ['\\', ''],
  ['//', ''],
  ['\\\\', ''],
  ['/mixed/\\', '/mixed'],
  ['C:\\Users\\me\\', 'C:\\Users\\me'],
  ['/Users/me/project', '/Users/me/project'],
  ['/Users/me/project/', '/Users/me/project'],
  ['/Users/me/project///', '/Users/me/project'],
  ['relative/dir\\/', 'relative/dir'],
  ['no-sep', 'no-sep'],
  ['trailing.dot.', 'trailing.dot.'],
  ['/a/b/c/\\/\\/', '/a/b/c'],
];

describe('stripTrailingPathSeparators', () => {
  it('matches the legacy trailing-separator strip on representative inputs', () => {
    for (const [input, expected] of CASES) {
      expect(stripTrailingPathSeparators(input)).toBe(expected);
    }
  });

  it('only strips the trailing run of separators', () => {
    expect(stripTrailingPathSeparators('/Users/me/project/')).toBe('/Users/me/project');
    expect(stripTrailingPathSeparators('/Users/me/project')).toBe('/Users/me/project');
    expect(stripTrailingPathSeparators('////')).toBe('');
    expect(stripTrailingPathSeparators('a\\b\\\\')).toBe('a\\b');
  });

  it('returns the same reference when there is nothing to strip', () => {
    const s = '/no/trailing/sep';
    expect(stripTrailingPathSeparators(s)).toBe(s);
  });
});
