import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { appFolderState, shouldReplaceExistingApp } from './app-folder.js';

test('只有 Mac 能判断是不是在程序文件夹', () => {
  assert.deepEqual(appFolderState({ isInApplicationsFolder: () => true }, 'darwin'), { in: true, can: true });
  assert.deepEqual(appFolderState({ isInApplicationsFolder: () => false }, 'darwin'), { in: false, can: true });
  assert.deepEqual(appFolderState({ isInApplicationsFolder: () => true }, 'linux'), { in: false, can: false });
  assert.deepEqual(appFolderState({}, 'darwin'), { in: false, can: false });
  assert.equal(shouldReplaceExistingApp('exists'), false);
  assert.equal(shouldReplaceExistingApp('existsAndRunning'), false);
  assert.equal(shouldReplaceExistingApp('existsAndSame'), true);
});

test('装机壳挂上了挪进程序文件夹，不是托盘', () => {
  const main = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  assert.match(main, /leocodebox-desktop:app-folder/);
  assert.match(main, /isInApplicationsFolder|appFolderState/);
  assert.match(main, /moveToApplicationsFolder/);
  assert.doesNotMatch(main, /new Tray\(/);
});
