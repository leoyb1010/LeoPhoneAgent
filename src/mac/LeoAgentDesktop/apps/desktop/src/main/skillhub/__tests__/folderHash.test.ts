/**
 * skillhub/folderHash.test.ts — 跨平台 folderHash 算法测试 (F-pub-4)
 *
 * 验证：
 *   - 跨平台一致性（CRLF / LF 文件同算法，hash 不同 → 二进制流式读）
 *   - 高风险 / 平台噪声路径排除，普通点号 fixture 参与 hash
 *   - 大文件（1MB）流式读不爆内存
 *   - 排序一致性（子目录遍历顺序不影响最终 hash）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { computeFolderHash } from '../folderHash';

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skillhash-test-'));
}

function writeFile(dir: string, relPath: string, content: Buffer | string): void {
  const fullPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function rmDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

// ── Test suite ─────────────────────────────────────────────────────────────────

describe('computeFolderHash', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = makeTmpDir();
  });

  afterAll(() => {
    rmDir(tmpDir);
  });

  it('produces a hex sha256 string', async () => {
    const dir = path.join(tmpDir, 'basic');
    writeFile(dir, 'SKILL.md', Buffer.from('# hello', 'utf8'));

    const hash = await computeFolderHash(dir);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('same content produces same hash on repeated calls', async () => {
    const dir = path.join(tmpDir, 'stable');
    writeFile(dir, 'SKILL.md', Buffer.from('stable content', 'utf8'));

    const h1 = await computeFolderHash(dir);
    const h2 = await computeFolderHash(dir);
    expect(h1).toBe(h2);
  });

  it('LF and CRLF files produce different hashes (binary-accurate)', async () => {
    // Binary stream, no line-ending normalization → LF ≠ CRLF
    const dirLf = path.join(tmpDir, 'lf');
    writeFile(dirLf, 'SKILL.md', Buffer.from('a\nb', 'utf8'));

    const dirCrlf = path.join(tmpDir, 'crlf');
    writeFile(dirCrlf, 'SKILL.md', Buffer.from('a\r\nb', 'utf8'));

    const hashLf = await computeFolderHash(dirLf);
    const hashCrlf = await computeFolderHash(dirCrlf);
    expect(hashLf).not.toBe(hashCrlf);
  });

  it('includes declared dotfile fixtures', async () => {
    const dir = path.join(tmpDir, 'dot-fixtures');
    writeFile(dir, 'SKILL.md', Buffer.from('visible', 'utf8'));
    writeFile(dir, '.cca-bindings.json', Buffer.from('fixture', 'utf8'));

    const dirNoDot = path.join(tmpDir, 'no-dot-fixtures');
    writeFile(dirNoDot, 'SKILL.md', Buffer.from('visible', 'utf8'));

    const h1 = await computeFolderHash(dir);
    const h2 = await computeFolderHash(dirNoDot);
    expect(h1).not.toBe(h2);
  });

  it('excludes sensitive dotfiles', async () => {
    const dir = path.join(tmpDir, 'sensitive-dotfiles');
    writeFile(dir, 'SKILL.md', Buffer.from('visible', 'utf8'));
    writeFile(dir, '.env', Buffer.from('TOKEN=secret', 'utf8'));
    writeFile(dir, '.env.local', Buffer.from('TOKEN=secret', 'utf8'));
    writeFile(dir, '.envrc', Buffer.from('export TOKEN=secret', 'utf8'));
    writeFile(dir, '.npmrc', Buffer.from('//registry/:_authToken=secret', 'utf8'));
    writeFile(dir, '.netrc', Buffer.from('machine example.com password secret', 'utf8'));
    writeFile(dir, '.pypirc', Buffer.from('[pypi]\npassword=secret', 'utf8'));
    writeFile(dir, '.ssh/id_rsa', Buffer.from('private key', 'utf8'));
    writeFile(dir, '.aws/credentials', Buffer.from('aws_secret_access_key=secret', 'utf8'));
    writeFile(dir, '.docker/config.json', Buffer.from('{"auths":{"example.com":{}}}', 'utf8'));
    writeFile(dir, '.gem/credentials', Buffer.from(':rubygems_api_key: secret', 'utf8'));
    writeFile(
      dir,
      '.config/gcloud/application_default_credentials.json',
      Buffer.from('{"client_secret":"secret"}', 'utf8'),
    );
    writeFile(dir, 'fixtures/.docker/config.json', Buffer.from('{"auths":{"example.com":{}}}', 'utf8'));
    writeFile(dir, 'fixtures/.gem/credentials', Buffer.from(':rubygems_api_key: secret', 'utf8'));
    writeFile(
      dir,
      'fixtures/.config/gcloud/application_default_credentials.json',
      Buffer.from('{"client_secret":"secret"}', 'utf8'),
    );
    writeFile(dir, '.kube/config', Buffer.from('token: secret', 'utf8'));
    writeFile(dir, '.config/gh/hosts.yml', Buffer.from('oauth_token: secret', 'utf8'));
    writeFile(dir, '.azure/accessTokens.json', Buffer.from('[]', 'utf8'));
    writeFile(dir, 'keys/id_ed25519', Buffer.from('private key', 'utf8'));
    writeFile(dir, 'certs/client.pem', Buffer.from('private key', 'utf8'));
    writeFile(dir, '.DS_Store', Buffer.from('metadata', 'utf8'));

    const dirClean = path.join(tmpDir, 'sensitive-dotfiles-clean');
    writeFile(dirClean, 'SKILL.md', Buffer.from('visible', 'utf8'));

    const h1 = await computeFolderHash(dir);
    const h2 = await computeFolderHash(dirClean);
    expect(h1).toBe(h2);
  });

  it('excludes node_modules directory', async () => {
    const dir = path.join(tmpDir, 'nodemodsex');
    writeFile(dir, 'SKILL.md', Buffer.from('skill content', 'utf8'));
    writeFile(dir, 'node_modules/some-pkg/index.js', Buffer.from('module code', 'utf8'));

    const dirClean = path.join(tmpDir, 'nodemodsex-clean');
    writeFile(dirClean, 'SKILL.md', Buffer.from('skill content', 'utf8'));

    const h1 = await computeFolderHash(dir);
    const h2 = await computeFolderHash(dirClean);
    expect(h1).toBe(h2);
  });

  it('excludes .git directory', async () => {
    const dir = path.join(tmpDir, 'gitex');
    writeFile(dir, 'SKILL.md', Buffer.from('skill', 'utf8'));
    writeFile(dir, '.git/HEAD', Buffer.from('ref: refs/heads/main', 'utf8'));

    const dirClean = path.join(tmpDir, 'gitex-clean');
    writeFile(dirClean, 'SKILL.md', Buffer.from('skill', 'utf8'));

    const h1 = await computeFolderHash(dir);
    const h2 = await computeFolderHash(dirClean);
    expect(h1).toBe(h2);
  });

  it('handles large binary file (1MB) without crash', async () => {
    const dir = path.join(tmpDir, 'large');
    // 1MB random-ish binary content
    const large = Buffer.alloc(1024 * 1024, 0xab);
    writeFile(dir, 'SKILL.md', Buffer.from('# big skill', 'utf8'));
    writeFile(dir, 'data.bin', large);

    const hash = await computeFolderHash(dir);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('normalizes to POSIX paths (cross-platform consistency)', async () => {
    // The hash includes "relPath:fileHash" lines sorted lexicographically.
    // On Windows, path.sep = '\\', but the hash algorithm replaces it with '/'.
    // We can't directly test the OS separator switch in unit tests, but we can
    // verify the sub-directory path appears correctly normalized in the output
    // by computing a predictable fixture.
    const dir = path.join(tmpDir, 'posix');
    writeFile(dir, 'a/b.md', Buffer.from('nested', 'utf8'));
    writeFile(dir, 'SKILL.md', Buffer.from('root', 'utf8'));

    const hash = await computeFolderHash(dir);
    // Re-compute manually using POSIX paths to verify correctness
    const bHash = crypto.createHash('sha256').update(Buffer.from('nested', 'utf8')).digest('hex');
    const skillHash = crypto.createHash('sha256').update(Buffer.from('root', 'utf8')).digest('hex');
    const lines = [`SKILL.md:${skillHash}`, `a/b.md:${bHash}`];
    lines.sort();
    const expected = crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
    expect(hash).toBe(expected);
  });

  it('different file content produces different hash', async () => {
    const dir1 = path.join(tmpDir, 'diff1');
    writeFile(dir1, 'SKILL.md', Buffer.from('content A', 'utf8'));

    const dir2 = path.join(tmpDir, 'diff2');
    writeFile(dir2, 'SKILL.md', Buffer.from('content B', 'utf8'));

    const h1 = await computeFolderHash(dir1);
    const h2 = await computeFolderHash(dir2);
    expect(h1).not.toBe(h2);
  });

  it('empty directory returns a valid deterministic hash', async () => {
    const dir = path.join(tmpDir, 'empty');
    fs.mkdirSync(dir, { recursive: true });

    const hash = await computeFolderHash(dir);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // Calling again should return the same hash
    const hash2 = await computeFolderHash(dir);
    expect(hash).toBe(hash2);
  });
});
