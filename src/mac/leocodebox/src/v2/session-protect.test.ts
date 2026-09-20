import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canSetContentProtection, contentProtectionLabel, contentProtectionToast } from './session-protect';

test('只有装机壳能在分享时藏住窗口', () => {
  assert.equal(canSetContentProtection(null), false);
  assert.equal(canSetContentProtection({}), false);
  assert.equal(canSetContentProtection({ setContentProtection: async () => ({ on: true }) }), true);
  assert.match(contentProtectionToast(true), /藏住窗口/);
  assert.match(contentProtectionToast(false), /取消/);
  assert.equal(contentProtectionLabel(false), '分享时藏住窗口');
  assert.equal(contentProtectionLabel(true), '不要藏住窗口');
});

test('2.0 壳接上了分享时藏住窗口，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const main = readFileSync(fileURLToPath(new URL('../../electron/main.js', import.meta.url)), 'utf8');
  assert.match(app, /canSetContentProtection/);
  assert.match(app, /contentProtectionLabel|藏不住窗口/);
  assert.match(main, /leocodebox-desktop:content-protection/);
  assert.match(main, /setContentProtection/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /分享时藏住窗口|不要藏住窗口/);
});
