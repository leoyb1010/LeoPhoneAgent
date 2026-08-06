/**
 * worktree-parallel-sessions: classifyError 6 类 + unknown 兜底单测。
 *
 * 验证 stderr 关键词、errno code、命中顺序。dubious-ownership 自动重试在 gitExec
 * 那层, 这里测的是"重试仍失败后"分类正确性。
 */

import { describe, it, expect } from 'vitest';

import { classifyError } from '../worktree/errorClassifier';

describe('classifyError', () => {
  it('classifies git-not-installed via spawn ENOENT', () => {
    const err = classifyError({
      cause: { code: 'ENOENT', syscall: 'spawn git' },
    });
    expect(err.kind).toBe('git-not-installed');
    expect(err.message).toContain('git');
    expect(err.hint).toContain('安装');
  });

  it('classifies not-a-git-repo from stderr', () => {
    const err = classifyError({
      stderr: 'fatal: not a git repository (or any of the parent directories): .git',
    });
    expect(err.kind).toBe('not-a-git-repo');
  });

  it('classifies dubious-ownership when retry already failed', () => {
    const err = classifyError({
      stderr: "fatal: detected dubious ownership in repository at 'C:/Users/foo/repo'",
    });
    expect(err.kind).toBe('dubious-ownership');
  });

  it('classifies dubious-ownership via safe.directory mention', () => {
    const err = classifyError({
      stderr: 'fatal: To add an exception use\nadd safe.directory C:/path',
    });
    expect(err.kind).toBe('dubious-ownership');
  });

  it('classifies git-crypt-locked', () => {
    const err = classifyError({
      stderr: 'unable to read git-crypt encrypted file',
    });
    expect(err.kind).toBe('git-crypt-locked');
  });

  it('classifies lfs-error from Smudge error', () => {
    const err = classifyError({
      stderr: 'Smudge error: Error downloading object from git-lfs',
    });
    expect(err.kind).toBe('lfs-error');
  });

  it('classifies permission-denied via EACCES errno', () => {
    const err = classifyError({
      cause: { code: 'EACCES' },
      stderr: '',
    });
    expect(err.kind).toBe('permission-denied');
  });

  it('classifies permission-denied via EBUSY (file locked)', () => {
    const err = classifyError({
      cause: { code: 'EBUSY' },
    });
    expect(err.kind).toBe('permission-denied');
  });

  it('classifies permission-denied via Windows "is being used by another process" stderr', () => {
    const err = classifyError({
      stderr: 'The process cannot access the file because it is being used by another process.',
    });
    expect(err.kind).toBe('permission-denied');
  });

  it('falls back to unknown with rawStderr when no rule matches', () => {
    const err = classifyError({
      stderr: 'some weird never-seen-before failure xyzzy',
    });
    expect(err.kind).toBe('unknown');
    expect(err.rawStderr).toContain('xyzzy');
    expect(err.hint).toBeUndefined();
  });

  it('order: not-a-git-repo wins over permission-denied when both keywords appear', () => {
    const err = classifyError({
      stderr: 'fatal: not a git repository — permission denied for fallback',
    });
    expect(err.kind).toBe('not-a-git-repo');
  });

  it('order: dubious-ownership wins over permission-denied', () => {
    const err = classifyError({
      stderr: "dubious ownership in repository at '/foo' — permission denied also mentioned",
    });
    expect(err.kind).toBe('dubious-ownership');
  });

  it('truncates very long stderr in unknown rawStderr', () => {
    const big = 'x'.repeat(10000);
    const err = classifyError({ stderr: big });
    expect(err.kind).toBe('unknown');
    expect(err.rawStderr!.length).toBeLessThanOrEqual(200);
  });
});
