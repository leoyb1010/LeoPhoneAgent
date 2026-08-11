import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  codexFallbackInternals,
  ensureFallbackCodexBinary,
  getCodexMetaVersion,
  isBundledCodexBinaryAvailable,
} from './codex-fallback.service.js';

test('dev installs keep using the bundled codex binary without downloading', async () => {
  // In the repo, @openai/codex-<platform> is installed, so the fallback must
  // step aside and let the SDK resolve its own binary.
  assert.equal(isBundledCodexBinaryAvailable(), true);
  assert.equal(await ensureFallbackCodexBinary(), null);
});

test('codex meta package version is resolvable for tarball URLs', () => {
  const version = getCodexMetaVersion();
  assert.ok(version && /^\d+\.\d+\.\d+/.test(version), `unexpected version: ${version}`);
});

test('fallback binary path mirrors the npm tarball layout', () => {
  const binaryPath = codexFallbackInternals.getFallbackBinaryPath('1.2.3', 'aarch64-apple-darwin');
  assert.ok(binaryPath.endsWith(
    path.join('.leocodebox', 'vendor', 'codex', '1.2.3', 'package', 'vendor', 'aarch64-apple-darwin', 'bin', 'codex'),
  ));
});

test('platform target exists for this machine', () => {
  const target = codexFallbackInternals.getPlatformTarget();
  assert.ok(target?.triple && target?.pkgSuffix);
});
