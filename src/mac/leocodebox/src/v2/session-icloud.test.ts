import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { icloudCwdToast, isIcloudPath } from './session-icloud';

test('能认出 iCloud 目录，普通目录不吓', () => {
  assert.equal(isIcloudPath('/Users/leo/Library/Mobile Documents/com~apple~CloudDocs/proj'), true);
  assert.equal(isIcloudPath('/Users/leo/Library/Mobile Documents/com~apple~CloudDocs'), true);
  assert.equal(isIcloudPath('/Users/leo/iCloud Drive/code'), true);
  assert.equal(isIcloudPath('/Users/leo/iCloud Drive'), true);
  assert.equal(isIcloudPath('/Users/leo/Documents/日常 2/LeoPhoneAgent'), false);
  assert.equal(isIcloudPath('/tmp/icloud-named-project'), false);
  assert.equal(isIcloudPath(''), false);
  assert.match(icloudCwdToast(), /iCloud/);
});

test('2.0 壳接上了 iCloud 提醒，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /isIcloudPath/);
  assert.match(app, /icloudCwdToast/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /iCloud|同步可能拖慢/);
});
