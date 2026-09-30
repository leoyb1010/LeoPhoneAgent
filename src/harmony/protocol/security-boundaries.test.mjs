// Run actual non-UI ETS through Node's TypeScript stripper with platform adapters.
// This exercises production decisions/IO, not an independent protocol mirror.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { randomUUID } from 'node:crypto';

const root = new URL('../app/entry/src/main/ets/', import.meta.url);
function load(relative, names, env = {}) {
  let source = fs.readFileSync(new URL(relative, root), 'utf8');
  source = source.replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')
    .replace(/\bexport\s+/g, '');
  const code = stripTypeScriptTypes(source, { mode: 'strip' });
  const context = vm.createContext({ console, setTimeout, clearTimeout, ArrayBuffer, Uint8Array, Date,
    ...env });
  vm.runInContext(`${code}\nObject.assign(globalThis, {${names.join(',')}});`, context, { filename: relative });
  return Object.fromEntries(names.map(name => [name, context[name]]));
}
const util = {
  generateRandomUUID: () => randomUUID(),
  TextEncoder: class { encodeInto(s) { return new TextEncoder().encode(s); } },
  Base64Helper: class {
    decodeSync(s) { return new Uint8Array(Buffer.from(s, 'base64')); }
    encodeToStringSync(s) { return Buffer.from(s).toString('base64'); }
  },
};
const calls = { writes: 0, reads: [], unlinks: [], copy: 0, locate: 0, get: 0 };
let shortWrite = false, failRename = false, failFsync = false;
const heldLocks = new Map();
const fileIo = {
  OpenMode: { READ_ONLY: fs.constants.O_RDONLY, READ_WRITE: fs.constants.O_RDWR,
    CREATE: fs.constants.O_CREAT, TRUNC: fs.constants.O_TRUNC,
    NOFOLLOW: fs.constants.O_NOFOLLOW, DIR: fs.constants.O_DIRECTORY },
  accessSync: fs.existsSync,
  mkdirSync: fs.mkdirSync,
  listFileSync: fs.readdirSync,
  readTextSync: p => fs.readFileSync(p, 'utf8'),
  openSync(p, flags) {
    calls.reads.push(p);
    const fd = fs.openSync(p, flags);
    return { fd, tryLock() { if (heldLocks.has(p)) throw new Error('busy'); heldLocks.set(p, fd); } };
  },
  closeSync(f) { for (const [p,fd] of heldLocks) if (fd===f.fd) heldLocks.delete(p); fs.closeSync(f.fd); },
  writeSync(fd, raw) {
    calls.writes++;
    const data = typeof raw === 'string' ? Buffer.from(raw) : Buffer.from(raw);
    return fs.writeSync(fd, data, 0, shortWrite ? Math.max(0, data.length - 1) : data.length);
  },
  readSync: (fd, raw) => fs.readSync(fd, Buffer.from(raw)),
  statSync: p => typeof p === 'number' ? fs.fstatSync(p) : fs.statSync(p),
  lstatSync: fs.lstatSync,
  fsyncSync(fd) { if (failFsync) throw new Error('injected fsync'); fs.fsyncSync(fd); },
  renameSync(a, b) { if (failRename) throw new Error('injected rename'); fs.renameSync(a, b); },
  unlinkSync(p) { calls.unlinks.push(p); fs.unlinkSync(p); },
};
const protocol = load('local/LocalProtocol.ets', ['sessionArchiveFromJson','sessionArchiveJson','LocalChatMessage',
  'LoopTurn','HISTORY_CHAR_BUDGET','trimHistory','toolArg','allowOpenUrl','weatherSummary',
  'titleFromPrompt','bucketTitle','dateBucket','ToolLoopGuard'], { util });
const agent = load('local/AgentText.ets', ['TextLine','STOPPED_NOTE','lastSummaryIndex','resumeNote',
  'attachedFilesBlock','summaryWrapper','dayKeyOf','scheduleDue']);
const atomic = load('store/AtomicFile.ets', ['atomicWriteText','AtomicTextFile'], { fileIo, util });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'harmony-security-'));
const context = { filesDir: temp };
try {
  // Atomic replacement preserves the previous bytes at every pre-rename fault.
  const config = path.join(temp, 'config.json');
  fs.writeFileSync(config, '{"old":true}');
  for (const fault of ['short','rename','fsync']) {
    shortWrite = fault === 'short'; failRename = fault === 'rename'; failFsync = fault === 'fsync';
    assert.throws(() => atomic.atomicWriteText(config, '{"next":"配置"}'));
    assert.equal(fs.readFileSync(config, 'utf8'), '{"old":true}', fault);
  }
  shortWrite = failRename = failFsync = false;
  atomic.atomicWriteText(config, '{"next":"配置"}');
  assert.equal(fs.readFileSync(config, 'utf8'), '{"next":"配置"}');
  assert.equal(fs.readdirSync(temp).filter(n => n.endsWith('.tmp')).length, 0);

  const left = new atomic.AtomicTextFile(), right = new atomic.AtomicTextFile();
  left.read(config); right.read(config);
  left.write(config, '{"winner":1}');
  assert.throws(() => right.write(config, '{"stale":true}'), /另一进程/);
  assert.equal(fs.readFileSync(config, 'utf8'), '{"winner":1}');
  right.read(config); right.write(config, '{"reloaded":true}');
  assert.equal(fs.readFileSync(config, 'utf8'), '{"reloaded":true}');

  let pixels = { width: 20, height: 20 };
  const image = { createImageSource: () => ({ getImageInfo: async () => ({ size: pixels }), release: async () => {} }) };
  const { SessionStore } = load('store/SessionStore.ets', ['SessionStore'],
    { fileIo, util, image, ...atomic, ...protocol });
  const store = new SessionStore();
  const secret = path.join(temp, 'provider.json');
  fs.writeFileSync(secret, 'PRIVATE');
  for (const p of [secret, temp + '/chat-images/../provider.json', temp + '/chat-images-other/123.jpg']) {
    const item = await store.importArchive(context, JSON.stringify({ messages: [{ role:'user', text:'photo', imagePath:p }] }));
    assert.equal(item.messages[0].imagePath, '');
    assert.equal(item.messages[0].imageB64, '');
    await store.remove(context, item.id);
    assert.equal(fs.readFileSync(secret, 'utf8'), 'PRIVATE');
    assert.ok(!calls.reads.includes(secret));
    assert.ok(!calls.unlinks.includes(secret));
  }
  // Existing tainted internal records also cannot read/delete outside or symlink files.
  fs.mkdirSync(path.join(temp, 'chat-images'), { recursive: true });
  const symlink = path.join(temp, 'chat-images', '123_456.jpg');
  fs.symlinkSync(secret, symlink);
  const bad = await store.create(context);
  bad.messages = [Object.assign(new protocol.LocalChatMessage(), { text:'x', imagePath:symlink })];
  await store.replaceMessages(context, bad);
  await store.get(context, bad.id);
  assert.equal(bad.messages[0].imagePath, '');
  await store.remove(context, bad.id);
  assert.equal(fs.readFileSync(secret, 'utf8'), 'PRIVATE');
  assert.ok(fs.existsSync(symlink));

  const png = Buffer.from([137,80,78,71,13,10,26,10,0,1,2,3]).toString('base64');
  const picture = await store.importArchive(context, JSON.stringify({ messages:[{role:'user',text:'valid',imageB64:png,imageMime:'image/png',imagePath:secret}] }));
  const picturePath = picture.messages[0].imagePath;
  assert.ok(picturePath.startsWith(temp + '/chat-images/'));
  assert.ok(fs.existsSync(picturePath));
  const duplicate = await store.duplicate(context, picture.id);
  await store.remove(context, picture.id);
  assert.ok(fs.existsSync(picturePath), 'shared attachment preserved');
  await store.remove(context, duplicate.id);
  assert.ok(!fs.existsSync(picturePath), 'last owner cleans attachment');
  pixels = { width: 100000, height: 100000 };
  await assert.rejects(store.importArchive(context, JSON.stringify({messages:[{role:'user',imageB64:png,imageMime:'image/png'}]})));
  await assert.rejects(store.importArchive(context, JSON.stringify({messages:[{role:'user',imageB64:Buffer.from('not a picture').toString('base64'),imageMime:'image/png'}]})));

  await assert.rejects(store.importArchive(context, JSON.stringify({messages:[{role:'user',
    imageB64:'A'.repeat(Math.ceil(8 * 1024 * 1024 * 4 / 3) + 8),imageMime:'image/png'}]})));
  const alternate = path.join(temp,'alternate'); fs.mkdirSync(alternate);
  fs.symlinkSync(path.join(temp,'chat-images'),path.join(alternate,'chat-images'));
  assert.throws(() => SessionStore.writeImageBytes({filesDir:alternate},new Uint8Array([1,2,3]).buffer,'image/png'));

  // Actual capability gates at quick-action and weather->location boundaries.
  const { SensitiveToolGate } = load('local/SensitiveToolGate.ets', ['SensitiveToolGate'], { fileIo, ...protocol });
  const { ActionRouter } = load('local/ActionRouter.ets', ['ActionRouter'], {});
  SensitiveToolGate.load = async () => {};
  const { FastLocalActions } = load('local/FastLocalActions.ets', ['FastLocalActions'], {
    SensitiveToolGate, ActionRouter, pasteboard:{ MIMETYPE_TEXT_PLAIN:'text', createData:(_,x)=>x,
      getSystemPasteboard:()=>({setData:async()=>{calls.copy++;}})},
  });
  SensitiveToolGate.fullAuto = false;
  await FastLocalActions.tryRoute(context, '复制到剪贴板：hello', 0, true);
  assert.equal(calls.copy, 0);
  assert.equal(await FastLocalActions.copyText('hello', false), true);
  assert.equal(calls.copy, 1);
  SensitiveToolGate.fullAuto = true;
  assert.equal(await FastLocalActions.copyText('hello', true), true);
  assert.equal(calls.copy, 2);
  SensitiveToolGate.fullAuto = false;
  const { PhoneTools } = load('local/PhoneTools.ets', ['PhoneTools'], { SensitiveToolGate, FastLocalActions, ...protocol });
  PhoneTools.locate = async () => { calls.locate++; return {latitude:1,longitude:2,name:'loc'}; };
  PhoneTools.geocode = async () => ({latitude:1,longitude:2,name:'city'});
  PhoneTools.getJson = async () => { calls.get++; return null; };
  await PhoneTools.run(context, 'weather', '{}', true);
  await PhoneTools.run(context, 'weather', '{"city":"  "}', true);
  await PhoneTools.run(context, 'location', '{}', true);
  assert.equal(calls.locate, 0); assert.equal(calls.get, 0);
  await PhoneTools.run(context, 'weather', '{"city":"北京"}', true);
  assert.equal(calls.locate, 0); assert.equal(calls.get, 1);
  await PhoneTools.run(context, 'weather', '{}', false);
  assert.equal(calls.locate, 1);

  // Shared conversation builder and the actual remote engine retain a second turn.
  const history = load('local/ConversationHistory.ets', ['conversationHistory'], {...protocol,...agent});
  const messages = [['user','remember blue'],['assistant','blue saved'],['user','what color?']].map(([role,text]) =>
    Object.assign(new protocol.LocalChatMessage(), {role,text}));
  const turns = history.conversationHistory(messages);
  assert.deepEqual(Array.from(turns, x => x.content), ['remember blue','blue saved','what color?']);
  const { LocalAgentEngine } = load('local/LocalAgentEngine.ets', ['LocalAgentEngine'], { ...protocol, SensitiveToolGate,
    FastLocalActions:{tryRoute:async()=>''}, taskStatus:{setRunning:()=>{}} });
  let captured;
  LocalAgentEngine.loop = (_ctx,_key,_mine,input) => { captured=input; };
  const generation = LocalAgentEngine.bump('remote');
  LocalAgentEngine.run(context,'remote',generation,'what color?','',()=>{},()=>{},()=>{},turns);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(Array.from(captured, x=>x.content), ['remember blue','blue saved','what color?']);
  const other = LocalAgentEngine.bump('other');
  LocalAgentEngine.run(context,'other',other,'separate','',()=>{},()=>{},()=>{});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(Array.from(captured, x=>x.content), ['separate']);

  // The actual relay router loads the prior persisted turn before its second send.
  LocalAgentEngine.run = (_ctx,_key,_mine,_text,_thinking,_delta,done,_error,input) => {
    captured = input;
    done('blue saved');
    return null;
  };
  const { HarmonyMinisRouter } = load('local/HarmonyMinisRouter.ets', ['HarmonyMinisRouter'], {
    LocalAgentEngine, LocalTools:{hydrate:async()=>{}}, sessionStore:store, ...history,
    ReleaseCatalog:{currentVersion:'test'}, errorBody:s=>JSON.stringify({error:s}),
  });
  const router = new HarmonyMinisRouter(); router.attach(context);
  const created = router.handle('POST','/harness/sessions',JSON.stringify({prompt:'remember blue'}));
  const remoteId = JSON.parse(created.body).session_id;
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(captured.length, 1);
  router.handle('POST',`/harness/sessions/${remoteId}/send`,JSON.stringify({text:'what color?'}));
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(Array.from(captured,x=>x.content),['remember blue','blue saved','what color?']);

  // Restart/cross-process-equivalent instances see the same durable daily claim.
  const { ScheduleStore, ScheduleTask } = load('store/ScheduleStore.ets', ['ScheduleStore','ScheduleTask'], { fileIo, ...atomic,...agent });
  const row = Object.assign(new ScheduleTask(), {rowId:'sch_test',title:'test',prompt:'do once',hour:0,minute:0});
  fs.writeFileSync(path.join(temp,'schedule.json'),JSON.stringify({rows:[row]}));
  assert.equal(ScheduleStore.claimSlot(context,row), true);
  assert.equal(ScheduleStore.claimSlot(context,row), false);
  const restarted = load('store/ScheduleStore.ets', ['ScheduleStore'], {fileIo,...atomic,...agent}).ScheduleStore;
  assert.equal(restarted.claimSlot(context,row), false, 'failed/crashed run never repeats automatically');
  const canceled = Object.assign(new ScheduleTask(), {rowId:'cancel',title:'cancel',prompt:'stop',hour:0,minute:0,on:false});
  fs.writeFileSync(path.join(temp,'schedule.json'),JSON.stringify({rows:[canceled]}));
  assert.equal(ScheduleStore.claimSlot(context,canceled), false);
  const source = rel => fs.readFileSync(new URL(rel,root),'utf8');
  assert.match(source('local/LocalTools.ets'), /PhoneTools\.run\(context, name, args, unattended\)/);
  assert.match(source('local/LocalAgentEngine.ets'), /tryRoute\(context, text, 0, true\)/);
  for (const name of ['ProviderStore','McpStore','EnvStore','ScheduleStore']) {
    const src = source(`store/${name}.ets`);
    assert.match(src, /this\.configFile\.write\(/);
    assert.doesNotMatch(src, /OpenMode\.TRUNC/);
  }
  console.log('HARMONY_SECURITY_BOUNDARIES_OK: production ETS attachment, capability, history, claim, atomic-IO regressions');
} finally {
  fs.rmSync(temp, { recursive:true, force:true });
}

await import('./configuration-generations.test.mjs');
await import('./secret-query-models.test.mjs');
