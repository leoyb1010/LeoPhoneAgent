import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'leobot-workspace-'));
const filesDir = path.join(base, 'app-files');
fs.mkdirSync(filesDir);
const outside = path.join(base, 'private-sentinel');
fs.writeFileSync(outside, 'PRIVATE_SENTINEL');
let shortWrite = false;

const descriptors = new Map();
const positions = new Map();
let afterDirectoryOpened;
let maxRead = 0;
function resolvePath(value) {
  const match = /^\/proc\/self\/fd\/(\d+)(\/.*)?$/.exec(value);
  if (!match) return value;
  const directory = descriptors.get(Number(match[1]));
  assert.ok(directory, 'A directory descriptor must remain open');
  return directory + (match[2] || '');
}
function stat(value, nofollow = false) {
  const result = typeof value === 'number' ? fs.fstatSync(value) : (nofollow ? fs.lstatSync(resolvePath(value)) : fs.statSync(resolvePath(value)));
  result.mtime = result.mtimeMs;
  return result;
}
const fileIo = {
  OpenMode: { READ_ONLY: fs.constants.O_RDONLY, READ_WRITE: fs.constants.O_RDWR,
    CREATE: fs.constants.O_CREAT, TRUNC: fs.constants.O_TRUNC, EXCL: fs.constants.O_EXCL,
    NOFOLLOW: fs.constants.O_NOFOLLOW, DIR: fs.constants.O_DIRECTORY },
  WhenceType: { SEEK_SET: 0 },
  accessSync: value => fs.existsSync(resolvePath(value)),
  openSync(name, flags) {
    const resolved = resolvePath(name);
    const fd = fs.openSync(resolved, flags, 0o600);
    descriptors.set(fd, resolved); positions.set(fd, 0);
    if (flags & fs.constants.O_DIRECTORY) afterDirectoryOpened?.(resolved);
    return { fd };
  },
  closeSync(value) { const fd = typeof value === 'number' ? value : value.fd; fs.closeSync(fd); descriptors.delete(fd); positions.delete(fd); },
  lseek(fd, position) { positions.set(fd, position); return position; },
  readSync(fd, data) {
    maxRead = Math.max(maxRead, data.byteLength);
    const count = fs.readSync(fd, Buffer.from(data), 0, data.byteLength, positions.get(fd));
    positions.set(fd, positions.get(fd) + count); return count;
  },
  writeSync(fd, data) {
    const bytes = Buffer.from(data);
    return fs.writeSync(fd, bytes, 0, shortWrite ? Math.max(0, bytes.byteLength - 1) : bytes.byteLength);
  },
  readTextSync: target => fs.readFileSync(resolvePath(target), 'utf8'),
  statSync: stat,
  lstatSync: target => { try { return stat(target, true); } catch (error) { if (error.code === 'ENOENT') error.code = 13900002; throw error; } },
  mkdirSync: target => fs.mkdirSync(resolvePath(target)),
  listFileSync: target => fs.readdirSync(resolvePath(target)),
  unlinkSync: target => fs.unlinkSync(resolvePath(target)),
  renameSync(source, destination) {
    const from = resolvePath(source); const to = resolvePath(destination);
    fs.renameSync(from, to);
    for (const [fd, current] of descriptors) if (current === from || current.startsWith(from + '/')) descriptors.set(fd, to + current.slice(from.length));
  },
  async copyFile(source, destination) {
    fs.ftruncateSync(destination, 0);
    const buffer = Buffer.alloc(65536); let position = 0;
    for (;;) {
      const count = fs.readSync(source, buffer, 0, buffer.length, position);
      if (!count) return;
      fs.writeSync(destination, buffer, 0, count, position); position += count;
    }
  },
  fsyncSync: fs.fsyncSync
};
const util = {
  generateRandomUUID: () => crypto.randomUUID(),
  TextEncoder: class { encodeInto(text) { return new TextEncoder().encode(text); } },
  TextDecoder: { create() {
    const decoder = new TextDecoder();
    return { decodeToString: (bytes, options) => decoder.decode(bytes, options) };
  } }
};
const appStorageValues = new Map();
const context = vm.createContext({ fileIo, util, console, setTimeout, nativeLinux: { createWorkspaceFile(parent, name) {
  try { return fileIo.openSync('/proc/self/fd/' + parent + '/' + name, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW).fd; }
  catch (error) { return error.code === 'EEXIST' ? -17 : -5; }
} }, Tokens: { apply() {} }, AppStorage: { get: key => appStorageValues.get(key), setOrCreate: (key, value) => appStorageValues.set(key, value) }, taskStatus: { setCardsEnabled() {} } });
const root = new URL('../app/entry/src/main/ets/store/', import.meta.url);
function execute(name) {
  const source = fs.readFileSync(new URL(name, root), 'utf8')
    .replace(/^import[^\n]*\n/gm, '').replace(/\bexport\s+/g, '');
  vm.runInContext(stripTypeScriptTypes(source, { mode: 'strip' }), context);
}
execute('AtomicFile.ets');
execute('WorkspaceStore.ets');
vm.runInContext('globalThis.store = WorkspaceStore;', context);
const store = context.store;
const app = { filesDir };

try {
  const content = 'a'.repeat(65535) + '中文🌿' + 'b'.repeat(65537);
  store.write(app, 'text.md', content);
  assert.equal(store.read(app, 'text.md'), content, 'UTF-8 characters split across IO chunks must survive');
  const preview = store.preview(app, 'text.md');
  assert.equal(preview.truncated, true);
  assert.equal(preview.text, Buffer.from(content).subarray(0, 128 * 1024).toString('utf8'));
  store.write(app, 'small.md', '中文🌿');
  assert.equal(store.preview(app, 'small.md').text, '中文🌿');
  fs.mkdirSync(path.join(filesDir, 'workspace', 'directory'));
  assert.equal(store.list(app).find(row => row.name === 'directory').directory, true);
  fs.writeFileSync(path.join(filesDir, 'workspace', 'binary.bin'), Buffer.from([0, 1, 2]));
  assert.throws(() => store.preview(app, 'binary.bin'), /二进制/);
  fs.symlinkSync(outside, path.join(filesDir, 'workspace', 'escape.txt'));
  assert.throws(() => store.read(app, 'escape.txt'), /符号链接/);
  assert.throws(() => store.write(app, 'escape.txt', 'changed'), /符号链接/);
  assert.throws(() => store.pathOf(app, 'escape.txt'), /符号链接/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'PRIVATE_SENTINEL');
  assert.equal(store.list(app).some(row => row.name === 'escape.txt'), false);
  assert.throws(() => store.read(app, '../private-sentinel'), /相对文件路径/);

  shortWrite = true;
  assert.throws(() => store.write(app, 'text.md', 'replacement'), /写入不完整/);
  shortWrite = false;
  assert.equal(store.read(app, 'text.md'), content);
  assert.equal(fs.readdirSync(path.join(filesDir, 'workspace')).some(name => name.endsWith('.tmp')), false);

  store.write(app, 'projects/中文/report..md', 'nested 中文🌿');
  assert.equal(store.read(app, 'projects/中文/report..md'), 'nested 中文🌿');
  assert.equal(store.list(app, 'projects/中文')[0].path, 'projects/中文/report..md');
  fs.symlinkSync(path.dirname(outside), path.join(filesDir, 'workspace', 'projects', 'link'));
  assert.throws(() => store.read(app, 'projects/link/private-sentinel'), /符号链接/);
  assert.throws(() => store.write(app, 'projects/link/private-sentinel', 'changed'), /符号链接/);
  store.createDirectory(app, 'race');
  let swapped = false;
  afterDirectoryOpened = directory => {
    if (!swapped && directory === path.join(filesDir, 'workspace', 'race')) {
      swapped = true;
      fileIo.renameSync(directory, directory + '-pinned');
      fs.symlinkSync(path.dirname(outside), directory);
    }
  };
  store.write(app, 'race/private-sentinel', 'PINNED_DIRECTORY_ONLY');
  afterDirectoryOpened = undefined;
  assert.equal(fs.readFileSync(outside, 'utf8'), 'PRIVATE_SENTINEL');
  assert.equal(fs.readFileSync(path.join(filesDir, 'workspace', 'race-pinned', 'private-sentinel'), 'utf8'), 'PINNED_DIRECTORY_ONLY');
  assert.equal(store.saveUpload(app, 'attachment.txt', new Uint8Array([70]).buffer), 'attachment.txt');
  assert.equal(store.saveUpload(app, 'attachment.txt', new Uint8Array([65]).buffer), 'attachment-2.txt');
  const destination = path.join(base, 'export.txt'); fs.writeFileSync(destination, 'old'.repeat(500));
  await store.exportTo(app, 'projects/中文/report..md', destination);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'nested 中文🌿');
  await assert.rejects(store.exportTo(app, 'text.md', path.join(filesDir, 'workspace', 'text.md')), /导出位置/);

  const mirror = vm.createContext({});
  const mirrorSource = fs.readFileSync(new URL('./localChat.ts', import.meta.url), 'utf8').replace(/\bexport\s+/g, '');
  vm.runInContext(stripTypeScriptTypes(mirrorSource, { mode: 'strip' }) + '\nglobalThis.reference = fileReadPage;globalThis.clip = clipFileRead;', mirror);
  const samples = ['', 'a', 'a\n', '\n\n', 'one\n中文🌿\nlast', 'x'.repeat(1024 * 1024 + 7) + '\nlast'];
  for (const text of samples) {
    store.write(app, 'page.txt', text);
    for (const direction of ['head', 'tail']) for (const offset of [1, 3, 20]) for (const count of [null, 0, 2]) {
      const window = await store.readWindow(app, 'page.txt', offset, count || 0, count !== null, 17, direction, () => true);
      const actual = mirror.clip(window.lines, window.showStart, window.totalLines, 17, direction === 'tail');
      const expected = mirror.reference(text.split('\n'), offset, count, 17, direction);
      assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)), JSON.stringify({ direction, offset, count, text: text.slice(0, 30) }));
    }
  }
  await assert.rejects(store.readWindow(app, 'page.txt', 1, 0, false, 17, 'head', () => false), /取消/);
  assert.ok(maxRead <= 1024 * 1024, 'Paged reads stay bounded to one MiB');

  const other = path.join(base, 'other');
  fs.mkdirSync(other);
  fs.symlinkSync(path.dirname(outside), path.join(other, 'workspace'));
  assert.throws(() => store.list({ filesDir: other }), /目录无效|符号链接/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'PRIVATE_SENTINEL');
  execute('ThemeStore.ets');
  vm.runInContext('globalThis.theme = themeStore;', context);
  const theme = context.theme;
  await theme.load(app); await theme.save(app);
  const savedRevision = appStorageValues.get('themeTick');
  assert.equal(savedRevision, 2, 'load and save publish distinct theme revisions');
  theme.mode = 'dark'; shortWrite = true;
  await assert.rejects(theme.save(app), /写入不完整/);
  assert.equal(appStorageValues.get('themeTick'), savedRevision, 'failed writes must not publish a new palette');
  shortWrite = false; await theme.reload(app);
  assert.equal(theme.mode, 'system', 'A failed appearance write reloads the prior persisted preference');
  assert.equal(descriptors.size, 0, 'All workspace descriptors must close');
  console.log('WORKSPACE_BOUNDARIES_OK actual ETS nested pinned-dirfd IO, ancestor replacement, symlink boundaries, UTF8 bounded paging, export and short-write preservation; OS7 procFD primitive separately verified');
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
