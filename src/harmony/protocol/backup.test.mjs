import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createHash,randomUUID} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
const source=fs.readFileSync(new URL('../app/entry/src/main/ets/backup/BackupStore.ets',import.meta.url),'utf8').replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm,'').replace(/\bexport\s+/g,'');
let failRename=false;
const io={OpenMode:{READ_ONLY:fs.constants.O_RDONLY,READ_WRITE:fs.constants.O_RDWR,CREATE:fs.constants.O_CREAT,TRUNC:fs.constants.O_TRUNC,NOFOLLOW:fs.constants.O_NOFOLLOW,DIR:fs.constants.O_DIRECTORY},
 accessSync:fs.existsSync,lstatSync:fs.lstatSync,listFileSync:fs.readdirSync,mkdirSync:fs.mkdirSync,
 openSync:(p,f)=>({fd:fs.openSync(p,f)}),readSync:(fd,b)=>fs.readSync(fd,Buffer.from(b)),
 writeSync:(fd,b)=>fs.writeSync(fd,Buffer.from(b)),fsyncSync:fs.fsyncSync,closeSync:f=>fs.closeSync(f.fd),
 readTextSync:p=>fs.readFileSync(p,'utf8'),unlinkSync:fs.unlinkSync,renameSync:(a,b)=>{if(failRename){failRename=false;throw new Error('injected rename');}fs.renameSync(a,b);}};
const env=vm.createContext({console,Uint8Array,ArrayBuffer,fileIo:io,BackupAccess:{beginExclusive:()=>({release(){}}),pending:ctx=>fs.existsSync(ctx.filesDir+'/restore-journal.json')||fs.existsSync(ctx.filesDir+'/restore-journal-v2.json')},
 util:{generateRandomUUID:randomUUID,Base64Helper:class{decodeSync(s){return new Uint8Array(Buffer.from(s,'base64'));}encodeToStringSync(b){return Buffer.from(b).toString('base64');}}},
 cryptoFramework:{createMd:()=>{let bytes;return{update:async b=>{bytes=b.data;},digest:async()=>({data:new Uint8Array(createHash('sha256').update(bytes).digest())})};}},
 atomicWriteText:(p,s)=>fs.writeFileSync(p,s),ChatRuns:{anyActive:()=>false},taskStatus:{running:false,pendingWrite:false}});
vm.runInContext(stripTypeScriptTypes(source,{mode:'strip'})+'\nglobalThis.BackupStore=BackupStore;',env);
const {BackupStore}=env;const temp=fs.mkdtempSync(path.join(os.tmpdir(),'harmony-backup-'));const context={filesDir:temp};
try{
 fs.writeFileSync(path.join(temp,'SOUL.md'),'original');fs.mkdirSync(path.join(temp,'workspace'));fs.writeFileSync(path.join(temp,'workspace','binary.bin'),Buffer.from([0,1,254,255]));
 const backup=await BackupStore.create(context);const raw=JSON.stringify(backup);
 assert.equal(backup.entries.length,2);await BackupStore.validate(raw);
 for(const unsafe of ['../SOUL.md','/SOUL.md','sessions/../../x','sessions/a/b','workspace/.','workspace/x.lock'])assert.equal(BackupStore.safePath(unsafe),false,unsafe);
 const malicious=JSON.parse(raw);malicious.entries[0].path='../escape';await assert.rejects(BackupStore.validate(JSON.stringify(malicious)),/路径/);
 const corrupt=JSON.parse(raw);corrupt.entries[0].data='AAAA';await assert.rejects(BackupStore.validate(JSON.stringify(corrupt)),/校验/);
 fs.writeFileSync(path.join(temp,'SOUL.md'),'latest');await BackupStore.restore(context,raw);
 assert.equal(fs.readFileSync(path.join(temp,'SOUL.md'),'utf8'),'latest','preparing recovery never changes a live Store');
 assert.ok(fs.existsSync(path.join(temp,'restore-journal.json')));
 BackupStore.recover(context);assert.equal(fs.readFileSync(path.join(temp,'SOUL.md'),'utf8'),'original');
 assert.equal(fs.existsSync(path.join(temp,'restore-journal.json')),false);
 assert.deepEqual(fs.readFileSync(path.join(temp,'workspace','binary.bin')),Buffer.from([0,1,254,255]));
 fs.writeFileSync(path.join(temp,'SOUL.md'),'keep-on-failure');await BackupStore.restore(context,raw);failRename=true;
 assert.throws(()=>BackupStore.recover(context),/回滚/);assert.equal(fs.readFileSync(path.join(temp,'SOUL.md'),'utf8'),'keep-on-failure');
 fs.symlinkSync('/etc/hosts',path.join(temp,'workspace','escape'));await assert.rejects(BackupStore.create(context),/不安全/);
 console.log('HARMONY_BACKUP_OK production ETS binary roundtrip, SHA256, traversal/symlink rejection, deferred startup recovery and rollback');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
