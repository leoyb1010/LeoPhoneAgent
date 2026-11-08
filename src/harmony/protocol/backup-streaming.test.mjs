// Execute the actual ETS package/journal stack against real host files. Native SDK archive proof is a separate OS7 probe.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash, randomUUID } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { spawnSync } from 'node:child_process';

const sourceRoot = new URL('../app/entry/src/main/ets/', import.meta.url);
const cursors = new Map();
const openPaths = new Map(), locks = new Map();
let maximumRead = 0, failRename = '', stopped = false;
const modes = { READ_ONLY: fs.constants.O_RDONLY, READ_WRITE: fs.constants.O_RDWR, CREATE: fs.constants.O_CREAT,
  TRUNC: fs.constants.O_TRUNC, NOFOLLOW: fs.constants.O_NOFOLLOW, DIR: fs.constants.O_DIRECTORY };
function stats(value) {
  const stat = typeof value === 'number' ? fs.fstatSync(value) : fs.lstatSync(value);
  return { size: stat.size, mtime: stat.mtimeMs, isFile: () => stat.isFile(), isDirectory: () => stat.isDirectory(), isSymbolicLink: () => stat.isSymbolicLink() };
}
const io = { OpenMode: modes, WhenceType: { SEEK_SET: 0 }, accessSync: fs.existsSync, lstatSync: stats, statSync: stats,
  listFileSync: fs.readdirSync, mkdirSync: fs.mkdirSync, rmdirSync: p => fs.rmSync(p, { recursive: true }), unlinkSync: fs.unlinkSync,
  openSync(p, flags) { const fd = fs.openSync(p, flags); cursors.set(fd, 0);openPaths.set(fd,p); return { fd,tryLock(exclusive){const held=locks.get(p)||new Map();if([...held.values()].some(value=>value)||exclusive&&held.size)throw Error('locked');held.set(fd,exclusive);locks.set(p,held);} }; },
  closeSync(file) { locks.get(openPaths.get(file.fd))?.delete(file.fd);openPaths.delete(file.fd);cursors.delete(file.fd); fs.closeSync(file.fd); },
  lseek(fd, offset, whence) { assert.equal(whence, 0); cursors.set(fd, offset); return offset; },
  readSync(fd, buffer) {
    maximumRead = Math.max(maximumRead, buffer.byteLength);
    const count = fs.readSync(fd, Buffer.from(buffer), 0, buffer.byteLength, cursors.get(fd));
    cursors.set(fd, cursors.get(fd) + count); return count;
  },
  writeSync(fd, buffer) {
    const bytes = Buffer.from(buffer);
    const count = fs.writeSync(fd, bytes, 0, bytes.length, cursors.get(fd));
    cursors.set(fd, cursors.get(fd) + count); return count;
  },
  fsyncSync: fs.fsyncSync, readTextSync: p => fs.readFileSync(p, 'utf8'),
  renameSync(a, b) { if (failRename && b.endsWith(failRename)) { failRename = ''; throw new Error('injected replacement failure'); } fs.renameSync(a, b); }
};
const util = { generateRandomUUID: () => randomUUID(),
  TextEncoder: class { encodeInto(s) { return new TextEncoder().encode(s); } },
  TextDecoder: { create(label, options) { const decoder = new TextDecoder(label, options); return { decodeToString: (bytes, options) => decoder.decode(bytes, options) }; } },
  Base64Helper: class { decodeSync(s) { return new Uint8Array(Buffer.from(s, 'base64')); } encodeToStringSync(bytes) { return Buffer.from(bytes).toString('base64'); } }
};
const cryptoFramework = { createMd() { const hash = createHash('sha256'); return { update: async blob => hash.update(blob.data), digest: async () => ({ data: new Uint8Array(hash.digest()) }) }; } };
function python(script, ...args) {
  const result = spawnSync('/usr/bin/python3', ['-c', script, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return result.stdout;
}
const nativeBackup = { async pack(_token, destination, sources) {
  python(`import sys,os,zipfile\nwith zipfile.ZipFile(sys.argv[1],'w',compression=zipfile.ZIP_STORED,allowZip64=True) as z:\n for source in sys.argv[2:]:\n  if os.path.isdir(source):\n   for root,dirs,files in os.walk(source):\n    for name in files:\n     p=os.path.join(root,name);z.write(p,os.path.relpath(p,os.path.dirname(source)))\n  else:z.write(source,os.path.basename(source))`, destination, ...sources);
}, progress: () => 100, cancel() {} };
const env = vm.createContext({ console, Uint8Array, ArrayBuffer, DataView, setTimeout, clearTimeout, setInterval, clearInterval,
  fileIo: io, util, cryptoFramework, nativeBackup, statvfs: { getFreeSize: async () => 100 * 1024 ** 3 },
  atomicWriteText(p, text) { fs.writeFileSync(p + '.tmp', text); fs.renameSync(p + '.tmp', p); },
  ChatRuns: { anyActive: () => false }, taskStatus: { running: false, pendingWrite: false } });
function load(file) {
  const source = fs.readFileSync(new URL(file, sourceRoot), 'utf8').replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '').replace(/\bexport\s+/g, '');
  vm.runInContext(stripTypeScriptTypes(source, { mode: 'strip' }), env, { filename: file });
}
for (const file of ['backup/BackupAccess.ets','backup/BackupFiles.ets', 'backup/BackupPaths.ets', 'backup/BackupZip.ets', 'backup/BackupDiskJournal.ets', 'backup/BackupStore.ets', 'backup/BackupPackage.ets']) load(file);
vm.runInContext('Object.assign(globalThis,{BackupPackage,BackupStore,BackupAccess,BackupLease,BackupDiskJournal,backupZipDirectory});', env);
function loadEntry(file, names, extra = {}) {
  const source = fs.readFileSync(new URL(file, sourceRoot), 'utf8').replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '').replace(/export default /g, '').replace(/\bexport\s+/g, '');
  const scope=vm.createContext({console,setTimeout,clearTimeout,ArrayBuffer,Uint8Array,BackupStore:env.BackupStore,BackupAccess:env.BackupAccess,BackupLease:env.BackupLease,...extra});
  vm.runInContext(stripTypeScriptTypes(source,{mode:'strip'})+'\nObject.assign(globalThis,{'+names.join(',')+'});',scope);
  return Object.fromEntries(names.map(name=>[name,scope[name]]));
}
const { BackupPackage, BackupStore, backupZipDirectory } = env;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leobot-streaming-backup-'));
const context = { filesDir: path.join(root, 'files'), cacheDir: path.join(root, 'cache') };
fs.mkdirSync(context.filesDir); fs.mkdirSync(context.cacheDir);
const current = () => !stopped, update = () => {};
try {
  // Independent VM instances model app entry processes sharing the kernel flock table.
  const otherStore=loadEntry('backup/BackupStore.ets',['BackupStore'],{fileIo:io,ChatRuns:{anyActive:()=>false},taskStatus:{running:false,pendingWrite:false},BackupDiskJournal:env.BackupDiskJournal}).BackupStore;
  const firstLease=BackupStore.beginExecution(context),secondLease=otherStore.beginExecution(context);
  assert.throws(()=>BackupStore.beginOperation(context),/正在使用/);
  firstLease.release();assert.throws(()=>BackupStore.beginOperation(context),/正在使用/,'closing another descriptor does not release the remaining reader');
  secondLease.release();BackupStore.beginOperation(context);
  assert.equal(otherStore.executionAllowed(context),false,'a different app process sees the writer lock');
  BackupStore.endOperation();assert.equal(otherStore.executionAllowed(context),true);
  const pointerPath=path.join(context.filesDir,'restore-journal-v2.json');
  fs.writeFileSync(pointerPath,'{}');
  let touched=0;
  let authorize=async()=>{touched++;return true;};
  const agentModule=loadEntry('agentextension/LeoAgentAbility.ets',['LeoAgentAbility'],{
    AgentExtensionAbility:class{context=context;},createA2AServer:()=>({updateStatus(){},addArtifact(){}}),
    AgentSettings:{enabled:()=>authorize()},TaskState:{FAILED:1,REJECTED:2},Role:{AGENT:0},util,
    LocalAgentEngine:{forget(){},stop(){}},providerStore:{ensureLoaded:async()=>{touched++;}},LocalTools:{hydrate:async()=>{touched++;}}
  });
  const agent=new agentModule.LeoAgentAbility();agent.onCreate({});
  await agent.dispatch('Execute',{getTaskId:()=> 'restore-blocked',getAgentId:()=> 'fixture',getUserInput:()=> 'do not run'});
  const scheduledStore={reload:async()=>{touched++;},dueNow:()=>[]};
  const schedule=loadEntry('local/ScheduleRunner.ets',['ScheduleRunner'],{scheduleStore:scheduledStore});
  await assert.rejects(schedule.ScheduleRunner.runDue(context,true),/恢复/);
  const work=loadEntry('workscheduler/ScheduleWork.ets',['ScheduleWork'],{WorkSchedulerExtensionAbility:class{context=context;},UiState:{uiBusy:()=>{touched++;return false;}},ScheduleRunner:{runDue:async()=>{touched++;return 1;}}});
  new work.ScheduleWork().onWorkStart({});
  const sharePreferences={getPreferences:async()=>{touched++;}};
  const share=loadEntry('shareextension/ShareInbox.ets',['ShareInbox'],{preferences:sharePreferences,AppStorage:{setOrCreate(){}},util,fileIo:io});
  await assert.rejects(share.ShareInbox.receive(context,{action:'ohos.want.action.sendData',parameters:{}}),/恢复/);
  await assert.rejects(share.ShareInbox.peek(context),/恢复/);await assert.rejects(share.ShareInbox.clear(context),/恢复/);
  const bodyState={load:async()=>{touched++;}};
  const body=loadEntry('net/OutboundClient.ets',['startBody'],{gatewayStore:{ensureLoaded:async()=>{touched++;}},providerStore:{ensureLoaded:async()=>{touched++;}},bodyStore:bodyState});
  body.startBody(context);
  const routerModule=loadEntry('local/HarmonyMinisRouter.ets',['HarmonyMinisRouter'],{errorBody:s=>JSON.stringify({error:s})});
  const router=new routerModule.HarmonyMinisRouter();router.attach(context);assert.equal(router.handle('POST','/harness/sessions','{}').status,503);
  const tools=loadEntry('local/LocalTools.ets',['LocalTools']);await assert.rejects(tools.LocalTools.run(context,'memory_write','{}'),/恢复/);
  assert.equal(touched,0,'pending restore blocks every non-UI entry before any configuration, claim or tool access');
  assert.ok(fs.existsSync(pointerPath),'background entry never auto-recovers or discards a journal');
  fs.unlinkSync(pointerPath);
  BackupStore.beginOperation(context);
  await assert.rejects(schedule.ScheduleRunner.runDue(context,true),/备份|使用/);
  await assert.rejects(share.ShareInbox.receive(context,{action:'ohos.want.action.sendData',parameters:{}}),/备份|使用/);
  await assert.rejects(tools.LocalTools.run(context,'memory_write','{}'),/备份|使用/);
  BackupStore.endOperation();
  // Cancellation during A2A authorization retains the lease until that authorization await settles.
  let releaseAuthorization;authorize=async()=>await new Promise(resolve=>{releaseAuthorization=resolve;});
  const request={getTaskId:()=> 'deferred-restore',getAgentId:()=> 'fixture',getUserInput:()=> 'hold'};
  const dispatch=agent.dispatch('Execute',request);assert.throws(()=>otherStore.beginOperation(context),/正在使用/);
  await agent.dispatch('Cancel',request);assert.throws(()=>otherStore.beginOperation(context),/正在使用/);
  releaseAuthorization(true);await dispatch;otherStore.beginOperation(context);otherStore.endOperation();
  let releaseReload;scheduledStore.reload=async()=>await new Promise(resolve=>{releaseReload=resolve;});
  const due=schedule.ScheduleRunner.runDue(context,true);assert.throws(()=>otherStore.beginOperation(context),/正在使用/);
  releaseReload();assert.equal(await due,0);otherStore.beginOperation(context);otherStore.endOperation();
  let releasePreference;sharePreferences.getPreferences=async()=>await new Promise(resolve=>{releasePreference=resolve;});
  const peeking=share.ShareInbox.peek(context);assert.throws(()=>otherStore.beginOperation(context),/正在使用/);
  releasePreference({get:async()=>''});assert.equal(await peeking,null);otherStore.beginOperation(context);otherStore.endOperation();
  let releaseBody;bodyState.load=async()=>await new Promise(resolve=>{releaseBody=resolve;});
  body.startBody(context);assert.throws(()=>otherStore.beginOperation(context),/正在使用/);
  releaseBody();await new Promise(resolve=>setImmediate(resolve));otherStore.beginOperation(context);otherStore.endOperation();
  // A cancelled tool retains its shared lease until the actual asynchronous operation settles.
  let finishTool;
  tools.LocalTools.runAllowed=async()=>await new Promise(resolve=>{finishTool=resolve;});
  const toolWork=tools.LocalTools.run(context,'memory_write','{}');
  assert.throws(()=>otherStore.beginOperation(context),/正在使用/);
  finishTool({text:'cancelled'});await toolWork;
  otherStore.beginOperation(context);otherStore.endOperation();
  console.log('HARMONY_BACKUP_ENTRY_GATES_OK actual A2A/WorkScheduler/Schedule/Share/body/router/tool entries reject pending journals or exclusive backup, shared lease held through deferred tool settlement');
  fs.writeFileSync(path.join(context.filesDir, 'SOUL.md'), 'original soul');
  fs.mkdirSync(path.join(context.filesDir, 'workspace/nested'), { recursive: true });
  const binaryPath = path.join(context.filesDir, 'workspace/nested/large.bin');
  const large = fs.openSync(binaryPath, 'w'), chunk = Buffer.alloc(1024 * 1024, 0xa5);
  try { for (let i = 0; i < 128; i++) fs.writeSync(large, chunk); } finally { fs.closeSync(large); }
  fs.writeFileSync(path.join(context.filesDir, 'workspace/nested/duplicate.txt'), 'original soul');
  const archive = await BackupPackage.create(context, current, update);
  assert.equal(archive.count, 3); assert.ok(archive.bytes > 96 * 1024 * 1024);
  const directory = await backupZipDirectory(archive.path);
  assert.equal(directory.filter(item => !item.directory && item.name.startsWith('blobs/')).length, 2, 'equal bytes are deduplicated');
  if (process.env.LEO_NATIVE_BACKUP_ZIP) {
    const nativeEntries = await backupZipDirectory(process.env.LEO_NATIVE_BACKUP_ZIP);
    assert.ok(nativeEntries.some(entry=>entry.size===128*1024*1024),'actual native OS7 archive parses through production reader');
  }
  const preview = await BackupPackage.preview(context, archive.path, current, update);
  assert.equal(preview.manifest.files, 3); assert.ok(maximumRead <= 1024 * 1024, 'no content read exceeds one MiB');
  fs.writeFileSync(path.join(context.filesDir, 'SOUL.md'), 'newer live value');
  await BackupPackage.prepareRestore(context, preview, current, update);
  assert.equal(fs.readFileSync(path.join(context.filesDir, 'SOUL.md'), 'utf8'), 'newer live value', 'prepare changes no live data');
  assert.ok(fs.existsSync(path.join(context.filesDir, 'restore-journal-v2.json')));
  const recovering=BackupStore.recoverAsync(context);
  assert.equal(BackupStore.recoverAsync(context),recovering,'same-process recover calls share one promise');
  await assert.rejects(otherStore.recoverAsync(context),/正在使用/,'another app process cannot apply the same journal concurrently');
  await recovering;
  assert.equal(fs.readFileSync(path.join(context.filesDir, 'SOUL.md'), 'utf8'), 'original soul');
  assert.equal(fs.statSync(binaryPath).size, 128 * 1024 * 1024);
  const fd = fs.openSync(binaryPath, 'r'); const end = Buffer.alloc(4); fs.readSync(fd, end, 0, 4, 128 * 1024 * 1024 - 4); fs.closeSync(fd); assert.deepEqual(end, Buffer.alloc(4, 0xa5));
  fs.writeFileSync(path.join(context.filesDir, 'SOUL.md'), 'keep after failure');
  const duplicatePath=path.join(context.filesDir,'workspace/nested/duplicate.txt');
  fs.unlinkSync(duplicatePath);
  const changed=fs.openSync(binaryPath,'r+');fs.writeSync(changed,Buffer.from([0xfe]),0,1,0);fs.closeSync(changed);
  await BackupPackage.prepareRestore(context, preview, current, update); failRename = '/workspace/nested/large.bin';
  await assert.rejects(BackupStore.recoverAsync(context), /回滚/);
  assert.equal(fs.readFileSync(path.join(context.filesDir, 'SOUL.md'), 'utf8'), 'keep after failure');
  assert.equal(fs.existsSync(path.join(context.filesDir, 'restore-journal-v2.json')), false);
  assert.equal(fs.existsSync(duplicatePath),false,'rollback removes a file created before a later replacement failed');
  const restoredHead=Buffer.alloc(1), restoredFile=fs.openSync(binaryPath,'r');fs.readSync(restoredFile,restoredHead,0,1,0);fs.closeSync(restoredFile);assert.equal(restoredHead[0],0xfe,'rollback preserves the pre-restore binary snapshot');
  // Simulate process death with an apply journal and one partially replaced live file.
  await BackupPackage.prepareRestore(context, preview, current, update);
  await assert.rejects(BackupStore.restore(context,JSON.stringify({format:'leobot-harmony-backup',version:1,entries:[]})),/已有恢复/);
  fs.writeFileSync(path.join(context.filesDir, 'SOUL.md'), 'partial replacement');
  await BackupStore.recoverAsync(context);
  assert.equal(fs.readFileSync(path.join(context.filesDir, 'SOUL.md'), 'utf8'), 'original soul');
  // A corrupted durable snapshot must stop startup before any replacement, retaining the recovery pointer.
  fs.writeFileSync(path.join(context.filesDir,'SOUL.md'),'keep on bad snapshot');
  await BackupPackage.prepareRestore(context,preview,current,update);
  const pointer=path.join(context.filesDir,'restore-journal-v2.json');
  const journal=JSON.parse(fs.readFileSync(pointer,'utf8'));
  const afterRows=fs.readFileSync(path.join(context.filesDir,journal.directory,'after.index.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  const soul=afterRows.find(row=>row.path==='SOUL.md');
  const snapshot=path.join(context.filesDir,journal.directory,'after',soul.sha256);fs.writeFileSync(snapshot,'corrupted');
  await assert.rejects(BackupStore.recoverAsync(context),/校验/);
  assert.ok(fs.existsSync(pointer));assert.equal(fs.readFileSync(path.join(context.filesDir,'SOUL.md'),'utf8'),'keep on bad snapshot');
  fs.copyFileSync(path.join(preview.directory,'package/blobs',soul.sha256.slice(0,2),soul.sha256),snapshot);
  // A process interrupted during rollback resumes the old snapshot, even when some live paths were already replaced.
  journal.phase='rollback';fs.writeFileSync(pointer,JSON.stringify(journal));fs.writeFileSync(path.join(context.filesDir,'SOUL.md'),'partial rollback');
  await assert.rejects(BackupStore.recoverAsync(context),/回滚/);
  assert.equal(fs.readFileSync(path.join(context.filesDir,'SOUL.md'),'utf8'),'keep on bad snapshot');
  stopped = true; await assert.rejects(BackupPackage.create(context, current, update), /取消/); stopped = false;
  assert.equal(fs.readdirSync(context.cacheDir).filter(name => name.startsWith('backup-export-') && !name.endsWith('.leobak')).length, 0);
  const corrupt = path.join(root, 'corrupt.leobak'); fs.copyFileSync(archive.path, corrupt);
  const blob = directory.find(item => item.name.startsWith('blobs/') && !item.directory);
  const bad = fs.openSync(corrupt, 'r+'); fs.writeSync(bad, Buffer.from([0]), 0, 1, blob.dataOffset); fs.closeSync(bad);
  await assert.rejects(BackupPackage.preview(context, corrupt, current, update), /哈希|校验/);
  const zip64=path.join(root,'zip64.zip');
  python(`import sys,zipfile,struct\nwith zipfile.ZipFile(sys.argv[1],'w',allowZip64=True) as z:\n with z.open('manifest.json','w',force_zip64=True) as f:f.write(b'{}')\n z.writestr('files.index.jsonl','')\nb=bytearray(open(sys.argv[1],'rb').read());p=len(b)-22;count=struct.unpack_from('<H',b,p+10)[0];size,offset=struct.unpack_from('<II',b,p+12);e=bytearray(b[p:]);struct.pack_into('<HHII',e,8,65535,65535,0xffffffff,0xffffffff);record=struct.pack('<IQHHIIQQQQ',0x06064b50,44,45,45,0,0,count,count,size,offset);locator=struct.pack('<IIQI',0x07064b50,0,p,1);open(sys.argv[1],'wb').write(b[:p]+record+locator+e)`,zip64);
  assert.equal((await backupZipDirectory(zip64)).length,2,'ZIP64 local sizes and EOCD records are accepted');
  for (const attack of ['traversal', 'symlink', 'duplicate', 'deflate']) {
    const malicious = path.join(root, attack + '.zip');
    python(`import sys,zipfile\np=sys.argv[1];attack=sys.argv[2]\nwith zipfile.ZipFile(p,'w') as z:\n z.writestr('manifest.json','{}');z.writestr('files.index.jsonl','')\n if attack=='traversal':z.writestr('../escape','bad')\n if attack=='symlink':\n  i=zipfile.ZipInfo('blobs/ab/'+'a'*64);i.create_system=3;i.external_attr=0o120777<<16;z.writestr(i,'/etc/hosts')\n if attack=='duplicate':z.writestr('manifest.json','{}')\n if attack=='deflate':z.writestr('blobs/ab/'+'a'*64,'x'*1024,compress_type=zipfile.ZIP_DEFLATED)`, malicious, attack);
    await assert.rejects(backupZipDirectory(malicious), /ZIP|路径/);
  }
  assert.equal(fs.existsSync(path.join(root, 'escape')), false);
  fs.symlinkSync('/etc/hosts', path.join(context.filesDir, 'workspace/escape'));
  await assert.rejects(BackupPackage.create(context, current, update), /不安全/);
  BackupPackage.discard(context, preview);
  console.log('HARMONY_STREAMING_BACKUP_OK actual ETS 128MiB disk roundtrip, one-MiB reads, dedup, nested files, legacy-compatible recovery gate, interrupted apply replay, disk rollback, cancellation cleanup and hostile ZIP rejection');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
