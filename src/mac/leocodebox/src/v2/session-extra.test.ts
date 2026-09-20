import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canOpenExtraWindow, extraWindowLabel, extraWindowToast } from './session-extra';

test('只有装机壳能再开一个窗口', () => {
  assert.equal(canOpenExtraWindow(null), false);
  assert.equal(canOpenExtraWindow({}), false);
  assert.equal(canOpenExtraWindow({ openExtraWindow: async () => ({ ok: true }) }), true);
  assert.equal(extraWindowLabel(), '再开一个窗口');
  assert.match(extraWindowToast(), /已再开一个窗口/);
});

test('2.0 壳接上了再开一个窗口，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const main = readFileSync(fileURLToPath(new URL('../../electron/main.js', import.meta.url)), 'utf8');
  assert.match(app, /extraWindowLabel|再开一个窗口/);
  assert.match(app, /openDesktopExtraWindow|extraHere/);
  assert.match(main, /leocodebox-desktop:extra-window/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /再开一个窗口|已再开一个窗口/);
});
