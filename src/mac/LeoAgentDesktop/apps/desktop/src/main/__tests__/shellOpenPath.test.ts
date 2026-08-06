import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/cindy-shell-open-test' },
}));

const { resolveShellOpenPathTarget } = await import('../shellOpenPath.js');

describe('resolveShellOpenPathTarget', () => {
  it('keeps absolute file paths unchanged', () => {
    const target = path.resolve('/tmp', 'recording.ogg');
    expect(resolveShellOpenPathTarget(target)).toBe(target);
  });

  it('resolves a valid cindy-media reference inside the main process', () => {
    const hash = 'a'.repeat(64);
    expect(resolveShellOpenPathTarget(`cindy-media://blobs/${hash}.ogg`)).toBe(
      // 实现走 path.resolve;win32 会把 /tmp 前缀解析出盘符,期望值同步用 resolve。
      path.resolve('/tmp/cindy-shell-open-test', 'cindy-media', 'blobs', 'aa', `${hash}.ogg`),
    );
  });

  it('rejects non-path inputs and malformed managed-media references', () => {
    expect(resolveShellOpenPathTarget('https://example.test/file.mp4')).toBeNull();
    expect(() => resolveShellOpenPathTarget('cindy-media://blobs/../../secret.ogg')).toThrow(
      'invalid url',
    );
  });
});
