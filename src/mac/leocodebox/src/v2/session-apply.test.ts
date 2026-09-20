import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { applyPatchToast, canApplySessionPatch, clipApplyPatch } from './session-apply';

test('只有本机才能贴补丁，空的和太长的拦住', () => {
  assert.equal(canApplySessionPatch('local'), true);
  assert.equal(canApplySessionPatch('fold'), false);
  assert.equal(clipApplyPatch('  diff --git a/a b/a\n'), '  diff --git a/a b/a\n');
  assert.throws(() => clipApplyPatch('x'.repeat(80_001)), /太长/);
  assert.match(applyPatchToast(['src/a.ts']), /src\/a.ts/);
  assert.match(applyPatchToast(['a', 'b']), /2/);
});

test('2.0 壳接上了贴上补丁，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /applyLocalPatch/);
  assert.match(app, /贴上补丁/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,600}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /贴上补丁/);
});
