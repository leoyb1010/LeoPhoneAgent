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
  assert.match(main, /leocodebox-desktop:open-term/);
  assert.match(main, /leocodebox-desktop:open-url/);
  assert.match(main, /leocodebox-desktop:speak-text/);
  assert.match(main, /leocodebox-desktop:print-text/);
  assert.match(main, /webContents\.print/);
  assert.match(main, /leocodebox-desktop:keep-awake/);
  assert.match(main, /leocodebox-desktop:open-at-login/);
  assert.match(main, /leocodebox-desktop:always-on-top/);
  assert.match(main, /leocodebox-desktop:play-done-sound/);
  assert.match(main, /setLoginItemSettings/);
  assert.match(main, /setAlwaysOnTop/);
  assert.match(main, /\/usr\/bin\/afplay/);
  assert.match(main, /powerSaveBlocker/);
  assert.match(main, /\/usr\/bin\/say/);
  assert.match(main, /showOpenDialog/);
  assert.match(main, /showItemInFolder|openPath/);
  assert.match(main, /-a.*Terminal|Terminal/);
  assert.match(preload, /pickFolder/);
  assert.match(preload, /revealPath/);
  assert.match(preload, /openPath/);
  assert.match(preload, /openTerm/);
  assert.match(preload, /openUrl/);
  assert.match(preload, /speakText/);
  assert.match(preload, /printText/);
  assert.match(preload, /keepAwake/);
  assert.match(preload, /getOpenAtLogin/);
  assert.match(preload, /setOpenAtLogin/);
  assert.match(preload, /getAlwaysOnTop/);
  assert.match(preload, /setAlwaysOnTop/);
  assert.match(preload, /playDoneSound/);
});
