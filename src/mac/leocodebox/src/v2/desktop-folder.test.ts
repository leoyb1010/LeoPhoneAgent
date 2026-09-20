import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canOpenSessionPath } from './desktop-folder';

test('只有本机且有路径才能用默认程序打开', () => {
  assert.equal(canOpenSessionPath('local', '/tmp/work/a.ts'), true);
  assert.equal(canOpenSessionPath('local', '  /tmp/work/a.ts  '), true);
  assert.equal(canOpenSessionPath('fold', '/tmp/work/a.ts'), false);
  assert.equal(canOpenSessionPath('local', ''), false);
  assert.equal(canOpenSessionPath('local', null), false);
});

test('工作台选目录优先桌面系统对话框,否则走本机 HTTP', () => {
  const source = readFileSync(fileURLToPath(new URL('./desktop-folder.ts', import.meta.url)), 'utf8');
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  const flow = readFileSync(fileURLToPath(new URL('./flow.tsx', import.meta.url)), 'utf8');
  const api = readFileSync(fileURLToPath(new URL('./api.ts', import.meta.url)), 'utf8');
  assert.match(source, /leocodeboxDesktopTools/);
  assert.match(source, /pickLocalFolder/);
  assert.match(source, /revealLocalPath/);
  assert.match(source, /openLocalPath/);
  assert.match(source, /openSessionPath/);
  assert.match(source, /openLocalTerminal/);
  assert.match(source, /openSessionTerm/);
  assert.match(api, /\/leophone\/local\/folder\/pick/);
  assert.match(api, /\/leophone\/local\/folder\/reveal/);
  assert.match(api, /\/leophone\/local\/folder\/open/);
  assert.match(api, /\/leophone\/local\/folder\/term/);
  assert.match(app, /onPickFolder=\{pickFolder\}/);
  assert.match(app, /在 Finder 打开/);
  assert.match(app, /在 Finder 显示/);
  assert.match(app, /用默认程序打开/);
  assert.match(app, /在终端打开/);
  assert.match(app, /openSessionPath/);
  assert.match(app, /openSessionTerm/);
  assert.match(flow, /onPickFolder/);
  assert.match(flow, /选择…/);
});
