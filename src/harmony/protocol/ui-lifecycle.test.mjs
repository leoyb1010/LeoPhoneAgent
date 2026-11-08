import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const root = new URL('../app/entry/src/main/ets/', import.meta.url);

function load(relative, globals, symbol) {
  const source = fs.readFileSync(new URL(relative, root), 'utf8')
    .replace(/^import[\s\S]*?;\s*/gm, '')
    .replace(/\bexport\s+default\s+/g, '')
    .replace(/\bexport\s+/g, '');
  const context = vm.createContext({ console, setTimeout, clearTimeout, ...globals });
  vm.runInContext(stripTypeScriptTypes(source, { mode: 'strip' }) + '\nglobalThis.subject = ' + symbol + ';', context);
  return context.subject;
}

let effects = 0;
const document = {
  hidden: false,
  title: 'Controlled browser',
  body: { innerText: 'Visible content' },
  querySelector(selector) {
    if (selector !== 'button') return null;
    return { click() { effects++; } };
  }
};
const page = vm.createContext({ document, location: { href: 'https://controlled.example/' } });
const grants = new Set();
const gate = { setResource() {}, consumeWriteGrant(owner) { return grants.delete(owner); } };
const browser = load('local/BrowserAutomation.ets', {
  browserStore: { active: () => ({ id: 'test-tab' }) },
  toolArg: (raw, key) => String(JSON.parse(raw)[key] ?? ''),
  SensitiveToolGate: gate,
  WRITE_GRANT_MARK: '__GRANT__'
}, 'BrowserAutomation');
const controller = { getUrl: () => 'https://controlled.example/', runJavaScript: async script => vm.runInContext(script, page) };
browser.setForeground(true);
browser.attach(controller, 'owner-a');
await assert.rejects(browser.run('click', '{"selector":"button"}', 'owner-a', true), /前台/);
await assert.rejects(browser.run('click', '{"selector":"button"}', 'owner-b', false), /前台/);
assert.match(await browser.run('click', '{"selector":"button"}', 'owner-a', false), /__GRANT__/);
assert.equal(effects, 0);
assert.match(await browser.run('get_text', '{}', 'owner-a', false), /Visible content/);
grants.add('owner-a');
await browser.run('click', '{"selector":"button"}', 'owner-a', false);
assert.equal(effects, 1);

document.hidden = true;
grants.add('owner-a');
await assert.rejects(browser.run('click', '{"selector":"button"}', 'owner-a', false), /页面已隐藏/);
assert.equal(effects, 1);
document.hidden = false;
browser.setForeground(false);
await assert.rejects(browser.run('get_text', '{}', 'owner-a', false), /前台/);
browser.setForeground(true);

let finish;
const delayed = { getUrl: () => 'https://controlled.example/', runJavaScript: () => new Promise(resolve => { finish = resolve; }) };
browser.attach(delayed, 'owner-a');
const pending = browser.run('get_text', '{}', 'owner-a', false);
browser.detach(delayed);
finish('stale private page');
await assert.rejects(pending, /取消/);
browser.attach(controller, 'owner-a');
await assert.rejects(browser.run('get_text', '{}', 'owner-a', false, () => false), /前台/);
assert.equal(effects, 1);

const values = new Map();
const liveUpdates = [];
const Status = load('store/TaskStatus.ets', {
  AppStorage: { setOrCreate: (key, value) => values.set(key, value) },
  FormStatus: { publish() {} },
  TaskLiveView: { update: async (id, state, finished) => { liveUpdates.push({ id, state, finished }); } }
}, 'TaskStatus');
const status = new Status();
status.setRunning(true, 'a');
status.setRunning(true, 'b');
status.setRunning(false, 'a');
assert.equal(status.running, true);
status.setPendingWrite(true, 'b');
status.setRunning(false, 'b');
assert.equal(status.running, false);
assert.equal(status.pendingWrite, true);
assert.equal(liveUpdates.at(-1).finished, false);
status.setPendingWrite(false, 'b');
assert.equal(status.pendingWrite, false);
assert.equal(liveUpdates.at(-1).finished, true);

class Ability { context = {}; }
const startupEvents = [];
const Entry = load('entryability/EntryAbility.ets', {
  UIAbility: Ability,
  themeStore: { detachWindow() {} },
  BackupStore: { async recoverAsync() { throw new Error('fault injected'); } },
  AppStorage: { setOrCreate: (key, value) => startupEvents.push([key, value]) },
  MotionPolicy: { stop() {} },
  WearTools: { cancelAll() {} },
  ReplicaSync: { stopForeground() {} },
  McpStdio: { closeAll() {} }
}, 'EntryAbility');
const entry = new Entry();
entry.onCreate({}, {});
entry.onForeground();
entry.onBackground();
entry.onNewWant({}, {});
const loaded = [];
entry.onWindowStageCreate({ loadContent: page => loaded.push(page) });
await entry.startup;
await Promise.resolve();
entry.onDestroy();
assert.deepEqual(loaded, ['pages/StartupPage', 'pages/RecoveryPage']);
assert.equal(startupEvents.length, 1);
assert.equal(startupEvents[0][0], 'startupRecoveryError');

let recoveryReady;
const deferredPages = [];
const DeferredEntry = load('entryability/EntryAbility.ets', {
  UIAbility: Ability,
  themeStore: { detachWindow() {} },
  BackupStore: { recoverAsync() { return new Promise(resolve => { recoveryReady = resolve; }); } },
  MotionPolicy: { stop() {} },
  WearTools: { cancelAll() {} },
  ReplicaSync: { stopForeground() {} },
  McpStdio: { closeAll() {} }
}, 'EntryAbility');
const waitingEntry = new DeferredEntry();
waitingEntry.onCreate({}, {});
waitingEntry.onForeground();
waitingEntry.onNewWant({}, {});
waitingEntry.onWindowStageCreate({ loadContent: page => deferredPages.push(page) });
waitingEntry.onBackground();
assert.deepEqual(deferredPages, ['pages/StartupPage']);
assert.equal(waitingEntry.startupComplete, false);
waitingEntry.onDestroy();
recoveryReady();
await waitingEntry.startup;
await Promise.resolve();
assert.equal(waitingEntry.startupComplete, false, 'Destroyed abilities must not start stores or consume wants after recovery');
assert.deepEqual(deferredPages, ['pages/StartupPage']);


const homeSource = fs.readFileSync(new URL('pages/HomePage.ets', root), 'utf8');
const backMatch = /onBackPress\(\): boolean \{([\s\S]*?)\n  \}/.exec(homeSource);
assert.ok(backMatch);
const backStorage = new Map([['homeSessionId', 'current-chat']]);
let hiddenKeyboard = 0;
const backContext = vm.createContext({
  inputMethod: { getController: () => ({ hideSoftKeyboard: async () => { hiddenKeyboard++; } }) },
  AppStorage: { get: key => backStorage.get(key), setOrCreate: (key, value) => backStorage.set(key, value) }
});
vm.runInContext(stripTypeScriptTypes('function back() {' + backMatch[1] + '\n} globalThis.back = back;', { mode: 'strip' }), backContext);
const backView = { keyboardVisible: true, wide: false, tab: 2 };
assert.equal(backContext.back.call(backView), true);
assert.equal(hiddenKeyboard, 1);
assert.equal(backView.tab, 2);
assert.equal(backStorage.get('homeSessionId'), 'current-chat');
backView.keyboardVisible = false;
assert.equal(backContext.back.call(backView), true);
assert.equal(backView.tab, 0);
assert.equal(backContext.back.call(backView), true);
assert.equal(backStorage.get('homeSessionId'), '');
assert.equal(backContext.back.call(backView), false);

const route = /private async routePush\(\): Promise<void> \{([\s\S]*?)\n  \}/.exec(homeSource);
assert.ok(route, 'Actual foreground notification consumer must exist');
const routeSource = stripTypeScriptTypes('async function routePush() {' + route[1] + '\n}', { mode: 'strip' });
const storage = new Map([['pushRemoteMachine', 'mac'], ['pushRemoteSession', 'session-1']]);
const gateway = { apiRoot: 'https://relay.example/api', key: 'test-key', hosts: [], ensureLoaded: async () => {} };
const navigations = [];
const launch = { sessions: new Map(), key: (machine, harness) => machine + ':' + harness };
const routeContext = vm.createContext({
  getContext: () => ({}),
  gatewayStore: gateway,
  MachinesClient: { list: async () => [{ name: 'mac', online: true }] },
  HarnessClient: class { async session() { return { harness: 'zcode' }; } },
  AppStorage: { get: key => storage.get(key) },
  ChatLaunch: launch,
  router: { pushUrl: async target => { navigations.push(target); } }
});
vm.runInContext(routeSource + '\nglobalThis.route = routePush;', routeContext);
const view = { pageAlive: true, foreground: true, notesReady: true, showNotes: false, pushRouting: false, pushRequest: 1, consumedPush: 0, pushError: '', onPushRequest() {} };
await routeContext.route.call(view);
assert.equal(navigations.length, 1);
assert.equal(launch.sessions.get('mac:zcode'), 'session-1');
await routeContext.route.call(view);
assert.equal(navigations.length, 1, 'Already-consumed push must not navigate twice');

let resolveMachines;
let machinesStarted;
const machinesReady = new Promise(resolve => { machinesStarted = resolve; });
routeContext.MachinesClient.list = () => new Promise(resolve => {
  resolveMachines = resolve;
  machinesStarted();
});
view.pushRequest = 2;
const old = routeContext.route.call(view);
await machinesReady;
gateway.apiRoot = 'https://other.example/api';
resolveMachines([{ name: 'mac', online: true }]);
await old;
assert.equal(navigations.length, 1, 'Connection changes must cancel old push routing');

console.log('UI_LIFECYCLE_OK actual ETS browser owner/visibility/grants/cancellation, task aggregation, recovery isolation and push revalidation');
