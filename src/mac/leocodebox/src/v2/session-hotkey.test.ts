import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canSetGlobalHotkey, globalHotkeyLabel, globalHotkeyToast } from './session-hotkey';

test('只有装机壳能设快捷键唤出', () => {
  assert.equal(canSetGlobalHotkey(null), false);
  assert.equal(canSetGlobalHotkey({}), false);
  assert.equal(canSetGlobalHotkey({ setGlobalHotkey: async () => ({ on: true }) }), true);
  assert.match(globalHotkeyToast(true), /打开快捷键唤出/);
  assert.match(globalHotkeyToast(false), /关掉快捷键唤出/);
  assert.equal(globalHotkeyLabel(false), '快捷键唤出');
  assert.equal(globalHotkeyLabel(true), '不要快捷键唤出');
});

test('2.0 壳接上了快捷键唤出，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const main = readFileSync(fileURLToPath(new URL('../../electron/main.js', import.meta.url)), 'utf8');
  assert.match(app, /canSetGlobalHotkey/);
  assert.match(app, /globalHotkeyLabel|快捷键唤出/);
  assert.match(main, /leocodebox-desktop:global-hotkey/);
  assert.match(main, /applyGlobalHotkey|globalHotkeyEnabled/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /快捷键唤出|不要快捷键唤出/);
});
