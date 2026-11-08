// Production ETS ZIP32 validation/install with explicit FileIO/zlib platform adapters.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {randomUUID,createHash} from 'node:crypto';
import {deflateRawSync,inflateRawSync,crc32} from 'node:zlib';
import {stripTypeScriptTypes} from 'node:module';
const root=new URL('../app/entry/src/main/ets/',import.meta.url);
function load(file,env={}){const raw=fs.readFileSync(new URL(file,root),'utf8');const names=[...raw.matchAll(/^export (?:class|function|const) (\w+)/gm)].map(m=>m[1]);const source=raw.replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm,'').replace(/\bexport\s+/g,'');const c=vm.createContext({console,ArrayBuffer,Uint8Array,...env});vm.runInContext(stripTypeScriptTypes(source,{mode:'strip'})+`\nObject.assign(globalThis,{${names.join(',')}});`,c);return Object.fromEntries(names.map(name=>[name,c[name]]));}
const positions=new Map();let fault=false;
const io={OpenMode:{READ_ONLY:fs.constants.O_RDONLY,READ_WRITE:fs.constants.O_RDWR,CREATE:fs.constants.O_CREAT,TRUNC:fs.constants.O_TRUNC,NOFOLLOW:fs.constants.O_NOFOLLOW,DIR:fs.constants.O_DIRECTORY},WhenceType:{SEEK_SET:0},
 accessSync:fs.existsSync,lstatSync:fs.lstatSync,statSync:p=>typeof p==='number'?fs.fstatSync(p):fs.statSync(p),mkdirSync:p=>fs.mkdirSync(p),rmdirSync:p=>fs.rmSync(p,{recursive:true}),listFileSync:p=>fs.readdirSync(p),readTextSync:p=>fs.readFileSync(p,'utf8'),
 openSync:(p,flags)=>{const fd=fs.openSync(p,flags);positions.set(fd,0);return{fd};},closeSync:f=>{positions.delete(f.fd);fs.closeSync(f.fd);},
 readSync:(fd,buffer)=>{const n=fs.readSync(fd,Buffer.from(buffer),0,buffer.byteLength,positions.get(fd));positions.set(fd,positions.get(fd)+n);return n;},
 writeSync:(fd,buffer)=>{const bytes=typeof buffer==='string'?Buffer.from(buffer):Buffer.from(buffer);const n=fs.writeSync(fd,bytes,0,bytes.length,positions.get(fd));positions.set(fd,positions.get(fd)+n);return n;},
 lseek:(fd,offset)=>{positions.set(fd,offset);return offset;},fsyncSync:fs.fsyncSync,renameSync:(a,b)=>{if(fault)throw new Error('injected rename');fs.renameSync(a,b);},unlinkSync:fs.unlinkSync};
const util={generateRandomUUID:()=>randomUUID(),TextEncoder:class{encodeInto(s){return new TextEncoder().encode(s);}},TextDecoder:{create:()=>({decodeToString:bytes=>new TextDecoder('utf-8',{fatal:true}).decode(bytes)})}};
const files=load('backup/BackupFiles.ets',{fileIo:io,util});
const zlib={ReturnStatus:{OK:0,STREAM_END:1},CompressFlushMode:{FINISH:4},createChecksumSync:()=>({crc32:async(seed,bytes)=>crc32(new Uint8Array(bytes),seed)}),createZipSync:()=>({inflateInit2:async()=>0,inflateEnd:async()=>0,inflate:async(stream)=>{const result=inflateRawSync(Buffer.from(stream.nextIn),{info:true,maxOutputLength:stream.availableOut});new Uint8Array(stream.nextOut).set(result.buffer);Object.assign(stream,{totalIn:result.engine.bytesWritten,availableIn:stream.nextIn.byteLength-result.engine.bytesWritten,totalOut:result.buffer.length,availableOut:stream.availableOut-result.buffer.length});return 1;}})};
const {SkillBundle}=load('sync/SkillBundle.ets',{...files,fileIo:io,util,zlib});
function zip(entries){const locals=[],central=[];let offset=0;for(const input of entries){const name=Buffer.from(input.name);const data=Buffer.from(input.data??'');let packed=input.deflate?deflateRawSync(data):data;if(input.trailing)packed=Buffer.concat([packed,Buffer.from('trailing')]);const flags=input.descriptor?8:0;const crc=crc32(data);const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(flags,6);header.writeUInt16LE(input.deflate?8:0,8);header.writeUInt32LE(input.badCrc?crc^1:crc,14);header.writeUInt32LE(packed.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(name.length,26);let descriptor=Buffer.alloc(0);if(input.descriptor){descriptor=Buffer.alloc(16);descriptor.writeUInt32LE(0x08074b50);descriptor.writeUInt32LE(crc,4);descriptor.writeUInt32LE(packed.length,8);descriptor.writeUInt32LE(data.length,12);}const row=Buffer.alloc(46);row.writeUInt32LE(0x02014b50);row.writeUInt16LE(flags,8);row.writeUInt16LE(input.deflate?8:0,10);row.writeUInt32LE(input.badCrc?crc^1:crc,16);row.writeUInt32LE(packed.length,20);row.writeUInt32LE(input.size??data.length,24);row.writeUInt16LE(name.length,28);if(input.symlink)row.writeUInt32LE(0xa0000000,38);row.writeUInt32LE(offset,42);locals.push(header,name,packed,descriptor);central.push(row,name);offset+=header.length+name.length+packed.length+descriptor.length;}const c=Buffer.concat(central);const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(c.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...locals,c,end]);}
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'harmony-skill-bundle-'));const context={filesDir:temp};let counter=0;
async function install(entries){const archive=path.join(temp,`archive-${counter++}.zip`);fs.writeFileSync(archive,zip(entries));return SkillBundle.install(context,archive,'---\nname: bundled\n---\nLATEST BODY');}
try{
 const installed=await install([{name:'scripts/run.py',data:'print("resource")',deflate:true,descriptor:true},{name:'SKILL.md',data:'OLD BODY'},{name:'assets/pixel.png',data:Buffer.from([0,1,2,255])}]);
 assert.equal(fs.readFileSync(SkillBundle.resource(context,installed.directory,'scripts/run.py'),'utf8'),'print("resource")');
 assert.match(fs.readFileSync(SkillBundle.resource(context,installed.directory,'SKILL.md'),'utf8'),/LATEST BODY/);
 assert.deepEqual(fs.readFileSync(SkillBundle.resource(context,installed.directory,'assets/pixel.png')),Buffer.from([0,1,2,255]));assert.ok(fs.existsSync(SkillBundle.archive(context,installed.directory)));
 for(const entries of [[{name:'../escape',data:'bad'}],[{name:'/absolute',data:'bad'}],[{name:'a',data:'x'},{name:'a/b',data:'y'}],[{name:'A.txt',data:'x'},{name:'a.txt',data:'y'}],[{name:'é',data:'x'},{name:'e\u0301',data:'y'}],[{name:'link',symlink:true,data:'../escape'}],[{name:'bad',data:'payload',badCrc:true}],[{name:'bomb',data:'x',size:65*1024*1024}],[{name:'trailing',data:'hello',deflate:true,trailing:true}]])await assert.rejects(install(entries));
 assert.equal(fs.readFileSync(SkillBundle.resource(context,installed.directory,'scripts/run.py'),'utf8'),'print("resource")','failed installs retain the old immutable tree');
 assert.equal(fs.readdirSync(path.join(temp,'skill-bundles')).filter(name=>name.endsWith('.tmp')).length,0,'failed extraction cleans its staging tree');
 assert.equal(SkillBundle.resource(context,installed.directory,'../archive.zip'),'');
 fs.symlinkSync('/etc/hosts',path.join(temp,'skill-bundles',installed.directory,'tree','external'));assert.equal(SkillBundle.resource(context,installed.directory,'external'),'');
 const atomic=load('store/AtomicFile.ets',{fileIo:io,util});const {MemoryStore}=load('store/MemoryStore.ets',{fileIo:io,...atomic});const memory=new MemoryStore();await memory.load(context);await memory.appendToday(context,'local one');
 const today=fs.readdirSync(path.join(temp,'memory')).find(name=>name!=='GLOBAL.md');fs.appendFileSync(path.join(temp,'memory',today),'\n<!-- incoming -->\nremote preserved\n');
 await memory.appendToday(context,'local two');assert.ok(memory.today.includes('remote preserved'));assert.ok((memory.today.match(/<!-- /g)||[]).length>=3);
 const before=memory.today;fault=true;await assert.rejects(memory.appendToday(context,'not committed'),/rename/);fault=false;assert.equal(memory.today,before);assert.equal(fs.readFileSync(path.join(temp,'memory',today),'utf8'),before);
 const textTools=load('local/AgentText.ets');const storeModule=load('store/SkillStore.ets',{...atomic,...textTools,SkillBundle,fileIo:io,util});const skillStore=new storeModule.SkillStore();
 const wire=load('sync/SyncProtocol.ets');const {ReplicaSync}=load('sync/ReplicaSync.ets',{...wire,SkillBundle,...storeModule,skillStore,fileIo:io,util,...atomic,
 ConfigReplica:{supported:()=>false,capture:async()=>[]},FileReplica:{supported:()=>false,capture:async()=>[]},SessionReplica:{supported:()=>false,capture:async()=>[]},MiscReplica:{supported:()=>false,capture:async()=>[],ensureCollectionSession:async()=>''}});
 const change=new wire.ReplicaChange();change.id.type='SkillV2';change.id.id='synced-skill';change.changeId='change-bundle-1';change.record=new wire.ReplicaRecord();change.record.id=change.id;
 change.record.fields.name=wire.textValue('bundled');change.record.fields.bodyText=wire.textValue('---\nname: bundled\n---\nINCOMING BODY');
 const archive=path.join(temp,'archive-0.zip');const hash=createHash('sha256').update(fs.readFileSync(archive)).digest('hex');change.record.assets.bundleAsset={key:'bundleAsset',sha256:hash,size:fs.statSync(archive).size,mimeType:'application/zip'};
 const state={pending:[],applied:{},records:{},lastRecords:{},localContent:{},materialized:{},revision:0};
 const transfers={download:async()=>archive,upload:async(source,key,mime)=>{assert.equal(key,'bundleAsset');assert.equal(mime,'application/zip');const bytes=fs.readFileSync(source);return{key,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length,mimeType:mime};}};
 await ReplicaSync.apply(context,state,change,transfers,true);await skillStore.load(context);assert.equal(skillStore.skills[0].bundleHash,hash);assert.equal(skillStore.resourceText(context,'skills/bundled/scripts/run.py'),'print("resource")');
 const original=skillStore.skills[0].body;fault=true;await assert.rejects(skillStore.upsert(context,'bundled','should fail'),/rename/);fault=false;assert.equal(skillStore.skills[0].body,original,'metadata write failure does not publish edited skill state');
 await skillStore.upsert(context,'bundled',original+'\nLOCAL EDIT');state.records['SkillV2:synced-skill']=change;
 await ReplicaSync.capture(context,state,transfers,'local-device');const outgoing=state.pending.find(row=>row.id.type==='SkillV2');assert.ok(outgoing.record.fields.bodyText.v.endsWith('LOCAL EDIT'));assert.equal(outgoing.record.assets.bundleAsset.sha256,hash,'outgoing skill revision retains the complete verified resource archive');
 console.log('HARMONY_SKILL_BUNDLE_OK actual ETS bounded ZIP32 stored/deflate/descriptors, CRC/path/Unicode/link/bomb/trailing rejection, immutable install/resource lookup, atomic timestamped daily memory');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
