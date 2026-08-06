// verify-sha256 单测：纯函数 + fail-closed 文件校验。
// node 内置 test runner，无 vitest 依赖：`node --test scripts/__tests__/verify-sha256.test.mjs`。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  sha256Hex,
  sha256File,
  normalizeExpectedSha256,
  assertSha256,
  verifyFileSha256OrRemove,
} from '../../tools/shared/verify-sha256.mjs';

// 已知向量（NIST）：便于跨实现核对。
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

function tmpFile(name, data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-sha256-test-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, data);
  return p;
}

test('sha256Hex: 已知向量(空串 / "abc")', () => {
  assert.equal(sha256Hex(''), EMPTY_SHA256);
  assert.equal(sha256Hex('abc'), ABC_SHA256);
  assert.equal(sha256Hex(Buffer.from('abc')), ABC_SHA256);
});

test('sha256File: 与 sha256Hex 对同一内容结果一致', () => {
  const p = tmpFile('bin', Buffer.from('abc'));
  assert.equal(sha256File(p), ABC_SHA256);
  // 大于 1MB 分块的内容也应正确（跨多个 read 块累积）。
  const big = Buffer.alloc((1 << 20) + 123, 7);
  const bp = tmpFile('big', big);
  assert.equal(sha256File(bp), sha256Hex(big));
});

test('normalizeExpectedSha256: 裸 hex / sha256: 前缀 / 大小写', () => {
  assert.equal(normalizeExpectedSha256(ABC_SHA256), ABC_SHA256);
  assert.equal(normalizeExpectedSha256(`sha256:${ABC_SHA256}`), ABC_SHA256);
  assert.equal(normalizeExpectedSha256(ABC_SHA256.toUpperCase()), ABC_SHA256);
  assert.equal(normalizeExpectedSha256(`  ${ABC_SHA256}  `), ABC_SHA256);
});

test('normalizeExpectedSha256: 非法输入一律返回 null', () => {
  assert.equal(normalizeExpectedSha256(null), null);
  assert.equal(normalizeExpectedSha256(undefined), null);
  assert.equal(normalizeExpectedSha256(''), null);
  assert.equal(normalizeExpectedSha256('deadbeef'), null); // 太短
  assert.equal(normalizeExpectedSha256(`${ABC_SHA256}00`), null); // 太长
  assert.equal(normalizeExpectedSha256(`zz${ABC_SHA256.slice(2)}`), null); // 非 hex 字符
  assert.equal(normalizeExpectedSha256(123), null); // 非字符串
});

test('assertSha256: 匹配(裸 + digest 形式)返回归一化 hex', () => {
  assert.equal(assertSha256({ actualHex: ABC_SHA256, expected: ABC_SHA256, label: 'x' }), ABC_SHA256);
  assert.equal(assertSha256({ actualHex: ABC_SHA256, expected: `sha256:${ABC_SHA256}`, label: 'x' }), ABC_SHA256);
  // actual 大写也应通过。
  assert.equal(assertSha256({ actualHex: ABC_SHA256.toUpperCase(), expected: ABC_SHA256, label: 'x' }), ABC_SHA256);
});

test('assertSha256: 不匹配抛错', () => {
  assert.throws(
    () => assertSha256({ actualHex: EMPTY_SHA256, expected: ABC_SHA256, label: 'claude darwin-arm64' }),
    /SHA256 mismatch for claude darwin-arm64/,
  );
});

test('assertSha256: 期望缺失 / 格式非法一律 fail-closed 抛错', () => {
  assert.throws(() => assertSha256({ actualHex: ABC_SHA256, expected: null, label: 'x' }), /no trusted sha256/);
  assert.throws(() => assertSha256({ actualHex: ABC_SHA256, expected: 'garbage', label: 'x' }), /no trusted sha256/);
});

test('verifyFileSha256OrRemove: 匹配时保留文件、返回 hex', () => {
  const p = tmpFile('bin', Buffer.from('abc'));
  assert.equal(verifyFileSha256OrRemove(p, `sha256:${ABC_SHA256}`, 'ok-bin'), ABC_SHA256);
  assert.equal(fs.existsSync(p), true);
});

test('verifyFileSha256OrRemove: 不匹配时删除文件并抛错(fail-closed)', () => {
  const p = tmpFile('bin', Buffer.from('tampered'));
  assert.throws(() => verifyFileSha256OrRemove(p, ABC_SHA256, 'bad-bin'), /SHA256 mismatch/);
  assert.equal(fs.existsSync(p), false); // 未验证的字节绝不留在磁盘上
});

test('verifyFileSha256OrRemove: 拿不到可信 hash 时也删除文件并抛错', () => {
  const p = tmpFile('bin', Buffer.from('abc'));
  assert.throws(() => verifyFileSha256OrRemove(p, null, 'no-hash-bin'), /no trusted sha256/);
  assert.equal(fs.existsSync(p), false);
});
