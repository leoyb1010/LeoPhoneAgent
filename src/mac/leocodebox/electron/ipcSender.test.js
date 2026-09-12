import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { isFirstPartyShellUrl } from './trustPolicy.js';

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const launcher = '/app/electron/launcher/index.html';
function harness() {
  const handlers = new Map();
  const writes = [];
  const context = vm.createContext({
    URL, process: { env: {}, platform: 'darwin' },
    isFirstPartyShellUrl, getLauncherPath: () => launcher,
    localServer: { getLocalServerPort: () => 38473 },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: () => {} },
    desktopNotifications: { saveSettings: async (settings) => { writes.push(settings); } },
    getDesktopState: () => ({ localStartupLogs: ['private'], ready: true }),
  });
  const start = source.includes('function isMainFrameIpcSender(')
    ? source.indexOf('function isMainFrameIpcSender(')
    : source.indexOf('function isAllowedLocalAuthOrigin(');
  vm.runInContext(source.slice(start, source.indexOf('async function showError(')), context);
  vm.runInContext(source.slice(source.indexOf('function registerIpcHandlers('), source.indexOf('function registerAppEvents(')), context);
  vm.runInContext('registerIpcHandlers()', context);
  return { context, writes, update: handlers.get('leocodebox-desktop:update-desktop-notifications') };
}
function event(url, { child = false, missing = false } = {}) {
  const mainFrame = { url, parent: null };
  return { senderFrame: missing ? undefined : child ? { url, parent: mainFrame } : mainFrame,
    sender: { mainFrame, getURL: () => url } };
}
for (const url of ['https://evil.example/', 'http://127.0.0.1:9999/', 'file:///tmp/index.html']) {
  test(`notification mutation rejects untrusted sender ${url}`, async () => {
    const h = harness();
    await assert.rejects(async () => h.update(event(url), { enabled: false }), /untrusted/);
    assert.equal(h.writes.length, 0);
  });
}
for (const url of ['http://127.0.0.1:38473/settings', `file://${launcher}`]) {
  test(`notification mutation permits first-party main frame ${url}`, async () => {
    const h = harness();
    const settings = { enabled: false };
    await h.update(event(url), settings);
    assert.deepEqual(h.writes, [settings]);
  });
  test(`notification mutation rejects child and missing frames ${url}`, async () => {
    const h = harness();
    for (const options of [{ child: true }, { missing: true }]) {
      await assert.rejects(async () => h.update(event(url, options), { enabled: false }), /untrusted/);
    }
    assert.equal(h.writes.length, 0);
  });
}
test('local auth rejects a forged claimed origin and a same-origin child frame', () => {
  const h = harness();
  const trusted = event('http://localhost:38473/');
  assert.equal(h.context.isTrustedLocalIpcSender(trusted, 'http://localhost:38473'), true);
  assert.equal(h.context.isTrustedLocalIpcSender(trusted, 'https://evil.example'), false);
  assert.equal(h.context.isTrustedLocalIpcSender(event('http://localhost:38473/', { child: true })), false);
});
