import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {createHash} from 'node:crypto';
const path = new URL('../app/entry/src/main/ets/local/LinuxRuntime.ets', import.meta.url);
const source = fs.readFileSync(path, 'utf8').replace(/^import[^\n]*\n/gm, '').replace(/\bexport\s+/g, '');
const processes = new Map();
const stopped = [];
const initialized = [];
let nextPid = 1;
let polls = 0;
let bootstrapStatus = 0;
let markerFault = false;
let markerExists = false;
let packageMounts = 0;
const pack = new TextEncoder().encode('signed-resource-fixture');
const nativeLinux = {
  packagesHash: () => createHash('sha256').update(pack).digest('hex'),
  preparePackages: async () => {packageMounts++;},
  packHash: () => createHash('sha256').update(pack).digest('hex'),
  initialize: async (...paths) => initialized.push(paths),
  start(command) {
    const pid = ++nextPid;
    processes.set(pid, {command, stopped: false});
    return pid;
  },
  startStdio(command) {return nativeLinux.start(command);},
  poll(pid) {
    polls++;
    const process = processes.get(pid);
    if (process.command === '/bin/sh /mnt/bootstrap/install.sh') return {buffer: new TextEncoder().encode(bootstrapStatus ? 'INSTALL_FAILED' : 'LEO_LINUX_BOOTSTRAP_COMPLETE').buffer, stderrBuffer:new ArrayBuffer(0), stderrTruncated:false, exited:true, exitCode:bootstrapStatus,truncated:false};
    return {buffer: new ArrayBuffer(0), stderrBuffer:new TextEncoder().encode("diagnostic only").buffer, stderrTruncated:false, exited: process.stopped, exitCode: process.stopped ? 137 : 0, truncated: false};
  },
  stop(pid) { stopped.push(pid); processes.get(pid).stopped = true; return 0; },
  write: (_pid, text) => new TextEncoder().encode(text).length,
  resize: () => 0,
};
const fileIo = {OpenMode: {},accessSync: path => !path.endsWith('.done') || markerExists,readTextSync: () => nativeLinux.packagesHash(),openSync: () => ({fd: 1}),
  write: async (_fd, buffer) => buffer.byteLength,fsync: async () => {},close: async () => {},
  writeSync: (_fd, buffer) => buffer.byteLength,fsyncSync() {},closeSync() {},unlinkSync() {}};
const committed = [];
const context = vm.createContext({console, Date, ArrayBuffer, Uint8Array, AppStorage: {setOrCreate() {},get: () => ''},
  atomicWriteText: (path,text) => {if(markerFault)throw new Error('injected storage failure');committed.push({path,text});},
  setTimeout: callback => {queueMicrotask(callback); return 1;},nativeLinux,fileIo,
  util: {TextEncoder: class {encodeInto(text) {return new TextEncoder().encode(text);}},
    TextDecoder: {create() {const decoder = new TextDecoder(); return {decodeToString: (bytes, options) => decoder.decode(bytes, options)};}}},
  cryptoFramework: {createMd() {let data; return {update: async blob => data = blob.data,
    digest: async () => ({data: createHash('sha256').update(data).digest()})};}},
  connection: {getDefaultNet: async () => ({}),getConnectionProperties: async () => ({dnses: [{address:'10.0.2.3'}]})},
});
vm.runInContext(stripTypeScriptTypes(source, {mode:'strip'}) + '\nglobalThis.Runtime=LinuxRuntime;', context);
const runtime = context.Runtime;
const app = {filesDir:'/app/private/files',cacheDir:'/app/private/cache',
  resourceManager: {getRawFileContent: async name => {assert.ok(['linux-rootfs.pack','linux-packages.pack'].includes(name)); return pack;}}};
await runtime.initialize(app);
assert.deepEqual(initialized[0], ['/app/private/files/linux-alpine-v1','/app/private/cache/linux-rootfs.pack','/app/private/files/workspace']);
assert.equal(committed.length,1);
assert.equal(committed[0].text,nativeLinux.packagesHash());
const stdio = runtime.startStdio('stdio-owner','echo rpc');
assert.equal(runtime.poll('stdio-owner',stdio).stderr,'diagnostic only');
assert.equal(runtime.writeStdio('stdio-owner',stdio,'request\n'),8);
assert.throws(() => runtime.writeStdio('other-owner',stdio,'bad'),/另一会话/);
const a = runtime.start('owner-a', 'sleep 10');
const b = runtime.start('owner-b', 'sleep 10');
assert.throws(() => runtime.stop('owner-a', b), /另一会话/);
assert.throws(() => runtime.poll('owner-b', a), /另一会话/);
runtime.cancelOwner('owner-a');
assert.deepEqual(stopped, [a]);
assert.equal(runtime.poll('owner-a', a).exitCode, 137);
assert.throws(() => runtime.write('owner-a', a, 'text'), /已结束/);
assert.throws(() => runtime.write('owner-b', b, 'x'.repeat(4097)), /4096/);
const before = nextPid;
await assert.rejects(runtime.run(app,'owner-c','echo cancelled',1000,() => false), /取消/);
assert.equal(nextPid, before);
polls = 0;
const result = await runtime.run(app,'owner-c','while :; do :; done',1000,() => polls === 0);
assert.equal(result.exitCode, 137);
assert.ok(stopped.includes(result.pid));
assert.ok(!stopped.includes(b));
console.log('LINUX_RUNTIME_OK actual ETS owner isolation, bounded input, trusted context paths, cancellation before/after start');

// Installation failure or an uncommitted marker must never turn initialization into success.
const markerCount = committed.length;
runtime.ready = false;
bootstrapStatus = 1;
await assert.rejects(runtime.initialize(app), /安装未完成/);
assert.equal(runtime.ready,false);
assert.equal(committed.length,markerCount);
bootstrapStatus = 0;
markerFault = true;
await assert.rejects(runtime.initialize(app), /storage failure/);
assert.equal(runtime.ready,false);
assert.equal(committed.length,markerCount);
markerFault = false;
await runtime.initialize(app);
assert.equal(runtime.ready,true);
assert.equal(committed.length,markerCount+1);
console.log('LINUX_BOOTSTRAP_MARKER_OK failed install/storage never commits readiness; explicit retry recovers');

// Persistent installation success is not a persistent native bind table.
markerExists = true;
runtime.ready = false;
const previousMounts = packageMounts;
const previousPids = nextPid;
await runtime.initialize(app);
assert.equal(packageMounts,previousMounts+1);
assert.equal(nextPid,previousPids,'completed installation must remount without replaying apk');
assert.equal(runtime.ready,true);
console.log('LINUX_BOOTSTRAP_RESTART_OK persisted marker still restores native readonly bind');
