import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { allSpacesLabel, allSpacesToast, canSetAllSpaces } from './session-spaces';

test('只有装机壳能跟着每个桌面', () => {
  assert.equal(canSetAllSpaces(null), false);
  assert.equal(canSetAllSpaces({}), false);
  assert.equal(canSetAllSpaces({ setVisibleOnAllWorkspaces: async () => ({ on: true }) }), true);
  assert.match(allSpacesToast(true), /每个桌面都在/);
  assert.match(allSpacesToast(false), /只留在这个桌面/);
  assert.equal(allSpacesLabel(false), '每个桌面都在');
  assert.equal(allSpacesLabel(true), '不要每个桌面');
});

test('2.0 壳接上了每个桌面，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const main = readFileSync(fileURLToPath(new URL('../../electron/main.js', import.meta.url)), 'utf8');
  assert.match(app, /canSetAllSpaces/);
  assert.match(app, /allSpacesLabel|跟着每个桌面/);
  assert.match(main, /leocodebox-desktop:all-spaces/);
  assert.match(main, /setVisibleOnAllWorkspaces/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /每个桌面都在|不要每个桌面/);
});
