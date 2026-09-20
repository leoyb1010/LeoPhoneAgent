import assert from 'node:assert/strict';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { expandDesktopFolderPath, isDesktopFolderAllowed } from './local-folder.js';

test('桌面选目录拦系统路径,家目录可以', () => {
  assert.equal(isDesktopFolderAllowed('/etc'), false);
  assert.equal(isDesktopFolderAllowed('/'), false);
  assert.equal(isDesktopFolderAllowed('~/Documents'), true);
  assert.equal(expandDesktopFolderPath('~/Documents'), path.join(os.homedir(), 'Documents'));
});

test('装机壳把选目录和揭示接到工作台', () => {
  const main = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  const preload = readFileSync(new URL('./preload.cjs', import.meta.url), 'utf8');
  assert.match(main, /leocodebox-desktop:pick-folder/);
  assert.match(main, /leocodebox-desktop:reveal-path/);
  assert.match(main, /leocodebox-desktop:open-path/);
  assert.match(main, /showOpenDialog/);
  assert.match(main, /showItemInFolder|openPath/);
  assert.match(preload, /pickFolder/);
  assert.match(preload, /revealPath/);
  assert.match(preload, /openPath/);
});
