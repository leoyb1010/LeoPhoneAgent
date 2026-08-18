import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * [T-quit] 「退出就是退出」的接线契约。
 *
 * 产品收缩后菜单栏托盘没有了,"关窗口 = 隐藏到托盘"这条老行为就没有落点:
 * 它只会让应用留在后台,而本地服务跟着一起活下去 —— 用户看到的正是
 * "退出后自动老重启"。这几条断言钉住的就是不许再退回那个状态。
 */
const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
const main = read('./main.js');
const desktopWindow = read('./desktopWindow.js');

const block = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end));

test('关掉最后一个窗口就退出,不再有"隐藏到托盘"的分支', () => {
  const handler = block(main, "app.on('window-all-closed'", "app.on('will-quit'");
  assert.ok(handler.includes('app.quit();'), 'window-all-closed 必须真的退出');
  assert.ok(!/if\s*\(\s*isQuitting\s*\)\s*app\.quit\(\)/.test(handler), 'app.quit() 不能再被 isQuitting 挡住');
});

test('退出时收本地服务走 stopLocalServer —— 接管来的服务也要停', () => {
  const handler = block(main, "app.on('before-quit', (event)", "app.on('window-all-closed'");
  assert.ok(handler.includes('localServer.stopLocalServer()'), '必须用 stopLocalServer,shutdownOwnedServer 管不到接管来的服务');
  assert.ok(handler.includes('keepLocalServerRunning'), '只有用户显式开了「退出后保温」才允许留后台服务');
});

test('退出流程进行中不再重开窗口', () => {
  const handler = block(main, "app.on('activate'", "app.on('before-quit'");
  assert.ok(/if\s*\(\s*isQuitting\s*\)\s*return;/.test(handler), 'activate 要在退出中直接返回,否则点 Dock 会把应用拉回来');
});

test('关窗口请求的是真退出,不是隐藏', () => {
  const handler = block(desktopWindow, "this.mainWindow.on('close'", "this.mainWindow.on('closed'");
  assert.ok(handler.includes('requestQuit'), '窗口 close 要发起真正的退出');
  assert.ok(!handler.includes('hide()'), 'close 不能退化成 hide()');
});

test('托盘整条线已经不存在了', () => {
  for (const forbidden of ['new Tray(', 'createTray', 'buildTrayMenu', 'quotaPopover']) {
    assert.ok(!desktopWindow.includes(forbidden), `desktopWindow.js 仍残留 ${forbidden}`);
  }
  assert.ok(!main.includes('createTray'), 'main.js 仍在创建托盘');
});
