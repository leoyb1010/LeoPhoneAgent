import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolvePathInsideRoot, PathBoundaryError } from '../shared/assertInsidePath.js';

const isWindows = process.platform === 'win32';

describe('resolvePathInsideRoot', () => {
  let root: string;

  beforeEach(async () => {
    // realpath the temp root so assertions compare against the canonical path
    // (macOS /var and /tmp are symlinks to /private/...).
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'assert-inside-')));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  describe('allows in-root paths', () => {
    it('resolves a relative path against root', async () => {
      const resolved = await resolvePathInsideRoot(root, 'out/result.txt');
      expect(resolved).toBe(path.join(root, 'out', 'result.txt'));
    });

    it('accepts an absolute path already inside root', async () => {
      const abs = path.join(root, 'nested', 'file.json');
      expect(await resolvePathInsideRoot(root, abs)).toBe(abs);
    });

    it('accepts a deep not-yet-existing target (parent dirs absent)', async () => {
      const abs = path.join(root, 'a', 'b', 'c', 'deep.txt');
      // No ancestor below root exists yet — must still be allowed (write target).
      expect(await resolvePathInsideRoot(root, 'a/b/c/deep.txt')).toBe(abs);
    });

    it('accepts an existing file inside root and follows an in-root symlink', async () => {
      const real = path.join(root, 'real.txt');
      await fs.writeFile(real, 'x', 'utf-8');
      expect(await resolvePathInsideRoot(root, 'real.txt')).toBe(real);
    });
  });

  describe('rejects out-of-root paths (fail-closed)', () => {
    it('rejects `..` traversal escaping root', async () => {
      await expect(resolvePathInsideRoot(root, '../escape.txt')).rejects.toBeInstanceOf(
        PathBoundaryError,
      );
    });

    it('rejects a deep `..` traversal that lands outside root', async () => {
      await expect(
        resolvePathInsideRoot(root, 'a/b/../../../escape.txt'),
      ).rejects.toBeInstanceOf(PathBoundaryError);
    });

    it('rejects an absolute path outside root', async () => {
      // 注意盘符冒号:'C\\Windows'(无冒号)不是绝对路径,会被当相对路径解析进 root。
      const outside = isWindows ? 'C:\\Windows\\System32\\x' : '/etc/passwd';
      await expect(resolvePathInsideRoot(root, outside)).rejects.toBeInstanceOf(
        PathBoundaryError,
      );
    });

    it.skipIf(isWindows)(
      'rejects a target under a symlink that points outside root (existing target)',
      async () => {
        // root/evil -> /etc ; target root/evil/passwd resolves (realpath) to /etc/passwd.
        await fs.symlink('/etc', path.join(root, 'evil'));
        await expect(
          resolvePathInsideRoot(root, 'evil/passwd'),
        ).rejects.toBeInstanceOf(PathBoundaryError);
      },
    );

    it.skipIf(isWindows)(
      'rejects a not-yet-existing target whose existing ancestor is a symlink out of root',
      async () => {
        // root/evil -> /etc ; target root/evil/new.txt does not exist, but the
        // nearest existing ancestor (root/evil) realpaths to /etc → escape.
        await fs.symlink('/etc', path.join(root, 'evil'));
        await expect(
          resolvePathInsideRoot(root, 'evil/new.txt'),
        ).rejects.toBeInstanceOf(PathBoundaryError);
      },
    );
  });

  describe('rejects unusable inputs', () => {
    it('rejects an empty root (no session workingDir)', async () => {
      await expect(resolvePathInsideRoot('', 'file.txt')).rejects.toBeInstanceOf(
        PathBoundaryError,
      );
      await expect(resolvePathInsideRoot('   ', 'file.txt')).rejects.toBeInstanceOf(
        PathBoundaryError,
      );
    });

    it('rejects an empty input path', async () => {
      await expect(resolvePathInsideRoot(root, '')).rejects.toBeInstanceOf(
        PathBoundaryError,
      );
    });

    it('rejects a non-existent root directory', async () => {
      const ghost = path.join(root, 'does-not-exist');
      await expect(
        resolvePathInsideRoot(ghost, 'file.txt'),
      ).rejects.toBeInstanceOf(PathBoundaryError);
    });
  });
});
