import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { LocalServerController } from './localServer.js';

async function makeScratchDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'leocodebox-localserver-test-'));
}

function startHealthServer(healthPayload) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(healthPayload));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

test('LocalServerController accepts an explicit development auth token', () => {
  const previousToken = process.env.LEOCODEBOX_LOCAL_AUTH_TOKEN;
  process.env.LEOCODEBOX_LOCAL_AUTH_TOKEN = 'leocodebox-development-token';

  try {
    const controller = new LocalServerController({
      appRoot: process.cwd(),
      settingsPath: '/tmp/leocodebox-test-settings.json',
      appVersion: 'test',
    });
    assert.equal(controller.getLocalAuthToken(), 'leocodebox-development-token');
  } finally {
    if (previousToken === undefined) {
      delete process.env.LEOCODEBOX_LOCAL_AUTH_TOKEN;
    } else {
      process.env.LEOCODEBOX_LOCAL_AUTH_TOKEN = previousToken;
    }
  }
});

test('keepLocalServerRunning persists through save and load', async () => {
  const scratch = await makeScratchDir();
  const settingsPath = path.join(scratch, 'desktop-settings.json');

  const controller = new LocalServerController({
    appRoot: process.cwd(),
    settingsPath,
    appVersion: 'test',
  });
  const result = await controller.updateDesktopSetting('keepLocalServerRunning', true);
  assert.equal(result.desktopSettings.keepLocalServerRunning, true);
  assert.equal(result.requiresRestartNotice, true);

  const reloaded = new LocalServerController({
    appRoot: process.cwd(),
    settingsPath,
    appVersion: 'test',
  });
  await reloaded.loadDesktopSettings();
  assert.equal(reloaded.getSettings().keepLocalServerRunning, true);
});

test('globalHotkeyEnabled persists through save and load', async () => {
  const scratch = await makeScratchDir();
  const settingsPath = path.join(scratch, 'desktop-settings.json');

  const controller = new LocalServerController({ appRoot: process.cwd(), settingsPath, appVersion: 'test' });
  // Default off; string "true" from the IPC bridge should coerce to boolean true.
  assert.equal(controller.getSettings().globalHotkeyEnabled, false);
  const result = await controller.updateDesktopSetting('globalHotkeyEnabled', 'true');
  assert.equal(result.desktopSettings.globalHotkeyEnabled, true);
  assert.equal(result.requiresRestartNotice, false);

  const reloaded = new LocalServerController({ appRoot: process.cwd(), settingsPath, appVersion: 'test' });
  await reloaded.loadDesktopSettings();
  assert.equal(reloaded.getSettings().globalHotkeyEnabled, true);
});

test('globalHotkeyAccelerator defaults to Alt+Space and persists a custom value', async () => {
  const scratch = await makeScratchDir();
  const settingsPath = path.join(scratch, 'desktop-settings.json');

  const controller = new LocalServerController({ appRoot: process.cwd(), settingsPath, appVersion: 'test' });
  assert.equal(controller.getSettings().globalHotkeyAccelerator, 'Alt+Space');
  await controller.updateDesktopSetting('globalHotkeyAccelerator', 'Control+Alt+Space');

  const reloaded = new LocalServerController({ appRoot: process.cwd(), settingsPath, appVersion: 'test' });
  await reloaded.loadDesktopSettings();
  assert.equal(reloaded.getSettings().globalHotkeyAccelerator, 'Control+Alt+Space');
});

test('unknown desktop settings are still rejected', async () => {
  const scratch = await makeScratchDir();
  const settingsPath = path.join(scratch, 'desktop-settings.json');
  const controller = new LocalServerController({ appRoot: process.cwd(), settingsPath, appVersion: 'test' });
  await assert.rejects(() => controller.updateDesktopSetting('nonexistentSetting', true));
});

test('adoptExistingServer reuses a healthy version-matched server and its marker token', async (t) => {
  const scratch = await makeScratchDir();
  const markerPath = path.join(scratch, 'local-server.json');
  const { server, port } = await startHealthServer({ status: 'ok', installMode: 'bundled', version: '9.9.9' });
  t.after(() => server.close());

  process.env.LEOCODEBOX_SERVER_MARKER_PATH = markerPath;
  t.after(() => { delete process.env.LEOCODEBOX_SERVER_MARKER_PATH; });

  await fs.writeFile(markerPath, JSON.stringify({
    url: `http://127.0.0.1:${port}`,
    pid: 999999999,
    version: '9.9.9',
    token: 'warm-resume-token',
  }), 'utf8');

  const controller = new LocalServerController({
    appRoot: process.cwd(),
    settingsPath: path.join(scratch, 'desktop-settings.json'),
    appVersion: '9.9.9',
  });
  const adopted = await controller.adoptExistingServer(`http://127.0.0.1:${port}`);

  assert.equal(adopted, `http://localhost:${port}`);
  assert.equal(controller.getLocalAuthToken(), 'warm-resume-token');
  assert.equal(controller.getLocalServerPort(), port);
});

test('adoptExistingServer refuses a version-mismatched server', async (t) => {
  const scratch = await makeScratchDir();
  const markerPath = path.join(scratch, 'local-server.json');
  const { server, port } = await startHealthServer({ status: 'ok', installMode: 'bundled', version: '1.0.0' });
  t.after(() => server.close());

  process.env.LEOCODEBOX_SERVER_MARKER_PATH = markerPath;
  t.after(() => { delete process.env.LEOCODEBOX_SERVER_MARKER_PATH; });

  await fs.writeFile(markerPath, JSON.stringify({
    url: `http://127.0.0.1:${port}`,
    // A dead pid: the stale-server termination path must skip it safely.
    pid: 999999999,
    version: '1.0.0',
    token: 'stale-token',
  }), 'utf8');

  const controller = new LocalServerController({
    appRoot: process.cwd(),
    settingsPath: path.join(scratch, 'desktop-settings.json'),
    appVersion: '2.0.0',
  });
  const adopted = await controller.adoptExistingServer(`http://127.0.0.1:${port}`);

  assert.equal(adopted, null);
  assert.notEqual(controller.getLocalAuthToken(), 'stale-token');
});

test('adoptExistingServer ignores a healthy server without an adoptable marker token', async (t) => {
  const scratch = await makeScratchDir();
  const { server, port } = await startHealthServer({ status: 'ok', installMode: 'bundled', version: '3.0.0' });
  t.after(() => server.close());

  process.env.LEOCODEBOX_SERVER_MARKER_PATH = path.join(scratch, 'missing-marker.json');
  t.after(() => { delete process.env.LEOCODEBOX_SERVER_MARKER_PATH; });

  const controller = new LocalServerController({
    appRoot: process.cwd(),
    settingsPath: path.join(scratch, 'desktop-settings.json'),
    appVersion: '3.0.0',
  });
  const adopted = await controller.adoptExistingServer(`http://127.0.0.1:${port}`);

  assert.equal(adopted, null);
});

/**
 * [T-quit-adopted] 退出时必须把**接管来的**服务也停掉。
 *
 * 回归的是用户报的"退出后自动老重启":暖启动会 adopt 上一次遗留的服务,
 * 此时 ownedServerProcess 为空,旧的 shutdownOwnedServer() 直接返回 ——
 * 后台服务永远活着,下次启动又被接管。
 */
test('stopLocalServer terminates an adopted server via its marker pid', async (t) => {
  const scratch = await makeScratchDir();
  const markerPath = path.join(scratch, 'local-server.json');
  const { server, port } = await startHealthServer({ status: 'ok', installMode: 'bundled', version: '9.9.9' });
  t.after(() => server.close());

  // 一个真的活着的进程来扮演"上一次留下来的服务"。
  const standIn = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { try { standIn.kill('SIGKILL'); } catch { /* already gone */ } });

  process.env.LEOCODEBOX_SERVER_MARKER_PATH = markerPath;
  t.after(() => { delete process.env.LEOCODEBOX_SERVER_MARKER_PATH; });

  await fs.writeFile(markerPath, JSON.stringify({
    url: `http://127.0.0.1:${port}`,
    pid: standIn.pid,
    version: '9.9.9',
    token: 'warm-resume-token',
  }), 'utf8');

  const controller = new LocalServerController({
    appRoot: process.cwd(),
    settingsPath: path.join(scratch, 'desktop-settings.json'),
    appVersion: '9.9.9',
  });
  assert.ok(await controller.adoptExistingServer(`http://127.0.0.1:${port}`));
  assert.equal(controller.hasOwnedServer(), false, '接管的服务本来就没有 ownedServerProcess');

  await controller.stopLocalServer();

  assert.throws(() => process.kill(standIn.pid, 0), '接管来的服务进程必须在退出时被停掉');
  assert.equal(controller.getLocalServerPort(), null);
});

test('stopLocalServer leaves an unrelated server alone', async (t) => {
  const scratch = await makeScratchDir();
  const markerPath = path.join(scratch, 'local-server.json');
  const { server, port } = await startHealthServer({ status: 'ok', installMode: 'bundled', version: '9.9.9' });
  t.after(() => server.close());

  const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { try { bystander.kill('SIGKILL'); } catch { /* already gone */ } });

  process.env.LEOCODEBOX_SERVER_MARKER_PATH = markerPath;
  t.after(() => { delete process.env.LEOCODEBOX_SERVER_MARKER_PATH; });

  await fs.writeFile(markerPath, JSON.stringify({
    url: `http://127.0.0.1:${port}`,
    pid: bystander.pid,
    version: '9.9.9',
    token: 'warm-resume-token',
  }), 'utf8');

  const controller = new LocalServerController({
    appRoot: process.cwd(),
    settingsPath: path.join(scratch, 'desktop-settings.json'),
    appVersion: '9.9.9',
  });
  assert.ok(await controller.adoptExistingServer(`http://127.0.0.1:${port}`));
  // marker 指向另一个端口 = 不是我们这次在用的那个服务,不能误杀。
  await fs.writeFile(markerPath, JSON.stringify({
    url: `http://127.0.0.1:${port + 1}`,
    pid: bystander.pid,
    version: '9.9.9',
    token: 'warm-resume-token',
  }), 'utf8');

  await controller.stopLocalServer();

  assert.doesNotThrow(() => process.kill(bystander.pid, 0), '端口对不上的服务不该被停掉');
});
