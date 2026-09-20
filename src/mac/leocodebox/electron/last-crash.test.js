import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { LAST_RUN_FILE, cleanLastRun, dirtyLastRun, lastRunWasAbrupt, parseLastRun } from './last-crash.js';

test('上次没干净退出才算崩', () => {
  assert.equal(lastRunWasAbrupt(parseLastRun(dirtyLastRun())), true);
  assert.equal(lastRunWasAbrupt(parseLastRun(cleanLastRun())), false);
  assert.equal(lastRunWasAbrupt(parseLastRun(null)), false);
  assert.equal(lastRunWasAbrupt(parseLastRun({ dirty: 'yes' })), false);
  assert.equal(LAST_RUN_FILE, 'last-run.json');
});

test('装机壳挂上了异常退出提醒，不是托盘', () => {
  const main = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  const preload = readFileSync(new URL('./preload.cjs', import.meta.url), 'utf8');
  assert.match(main, /leocodebox-desktop:last-crash/);
  assert.match(main, /beginLastRun|finishLastRun|LAST_RUN_FILE/);
  assert.match(preload, /lastAbrupt/);
  assert.doesNotMatch(main, /new Tray\(/);
});
