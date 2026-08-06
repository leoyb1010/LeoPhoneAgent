import { describe, expect, it } from 'vitest';

import { isSafeGitPath } from '../gitPath';

describe('git-review gitPath guards', () => {
  it('rejects .git path segments case-insensitively without rejecting names that merely contain .git', () => {
    expect(isSafeGitPath('.git/config')).toBe(false);
    expect(isSafeGitPath('a/.GIT/x')).toBe(false);
    expect(isSafeGitPath('.git./x')).toBe(false);
    expect(isSafeGitPath('.git /x')).toBe(false);
    expect(isSafeGitPath('.git../x')).toBe(false);
    expect(isSafeGitPath('GIT~1/x')).toBe(false);
    expect(isSafeGitPath('foo.git/x')).toBe(true);
    expect(isSafeGitPath('a.gitignore')).toBe(true);
    expect(isSafeGitPath('git/x')).toBe(true);
  });
});
