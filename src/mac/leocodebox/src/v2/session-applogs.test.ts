import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canOpenLogs, openLogsLabel, openLogsToast } from './session-applogs';

test('只有装机壳能打开日志', () => {
  assert.equal(canOpenLogs(null), false);
  assert.equal(canOpenLogs({}), false);
  assert.equal(canOpenLogs({ openLogs: async () => ({ path: '/tmp' }) }), true);
  assert.equal(openLogsLabel(), '打开日志');
  assert.match(openLogsToast(), /已打开日志/);
});

test('2.0 壳接上了打开日志，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const main = readFileSync(fileURLToPath(new URL('../../electron/main.js', import.meta.url)), 'utf8');
  assert.match(app, /canOpenLogs/);
  assert.match(app, /openLogsLabel|打开日志/);
  assert.match(main, /leocodebox-desktop:open-logs/);
  assert.match(main, /getPath\('logs'\)/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /打开日志|已打开日志/);
});
