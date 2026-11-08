import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {randomUUID,createHash} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
const root=new URL('../app/entry/src/main/ets/',import.meta.url);
function load(file,names,env={}){const s=fs.readFileSync(new URL(file,root),'utf8').replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm,'').replace(/\bexport\s+/g,'');const c=vm.createContext({console,...env});vm.runInContext(stripTypeScriptTypes(s,{mode:'strip'})+`\nObject.assign(globalThis,{${names.join(',')}});`,c);return Object.fromEntries(names.map(n=>[n,c[n]]));}
const protocol=load('sync/SyncProtocol.ets',['ReplicaRecord','ReplicaChange','PortableValue','replicaDate','replicaText','textValue','recordKey','APPLE_EPOCH_MS']);
const native=load('local/LocalProtocol.ets',['ChatImage','chatImages','LocalChatMessage']);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'harmony-misc-sync-'));const context={filesDir:temp};fs.mkdirSync(path.join(temp,'sessions'));fs.mkdirSync(path.join(temp,'memory'));
const io={accessSync:fs.existsSync,readTextSync:p=>fs.readFileSync(p,'utf8'),mkdirSync:fs.mkdirSync,listFileSync:fs.readdirSync,unlinkSync:fs.unlinkSync,lstatSync:fs.lstatSync,copyFileSync:fs.copyFileSync,statSync:p=>({mtime:fs.statSync(p).mtimeMs/1000})};
const {CollectionStore,CollectionItem}=load('store/CollectionStore.ets',['CollectionStore','CollectionItem'],{fileIo:io});const collectionStore=new CollectionStore();
const sessionStore={summaries:[],reload:async()=>{sessionStore.summaries=fs.readdirSync(path.join(temp,'sessions')).map(name=>({id:name.slice(0,-5)}));},get:async(_ctx,id)=>{const p=path.join(temp,'sessions',id+'.json');return fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):null;}};
const env={...protocol,...native,CollectionItem,collectionStore,sessionStore,SessionStore:{validId:id=>/^[a-f0-9-]{36}$/.test(id)},fileIo:io,atomicWriteText:(p,s)=>fs.writeFileSync(p,s),deviceInfo:{marketName:'Test phone',osFullName:'HarmonyOS 7'},ReleaseCatalog:{currentBuild:100028},util:{generateRandomUUID:randomUUID}};
const {MiscReplica}=load('sync/MiscReplica.ets',['MiscReplica'],env);
const {FileReplica}=load('sync/FileReplica.ets',['FileReplica'],{...env,ReplicaAssets:{valid:a=>/^[a-f0-9]{64}$/.test(a.sha256)&&a.size>=0,digest:async p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex')}});
function change(type,id,fields){const c=new protocol.ReplicaChange();c.id={type,id};c.operation='upsert';c.record=new protocol.ReplicaRecord();c.record.id=c.id;c.updatedAt=protocol.replicaDate(Date.now());c.record.updatedAt=c.updatedAt;for(const[k,v]of Object.entries(fields))c.record.fields[k]=typeof v==='number'?{t:'int',v}:protocol.textValue(v);return c;}
try{
 const local='<!-- same -->\nlocal content\n\nlegacy block';fs.writeFileSync(path.join(temp,'memory','2026-11-08.md'),local);
 const memory=change('MemoryDailyV2','2026-11-08',{dateKey:'2026-11-08',entriesJson:'[{"timestamp":"same","content":"remote content"}]'});await MiscReplica.apply(context,memory);
 const merged=MiscReplica.parseMemory(fs.readFileSync(path.join(temp,'memory','2026-11-08.md'),'utf8'));assert.equal(merged.length,2);assert.ok(merged.some(e=>e.content.includes('local content')));assert.ok(merged.some(e=>e.content==='remote content'));
 await MiscReplica.apply(context,memory);assert.equal(MiscReplica.parseMemory(fs.readFileSync(path.join(temp,'memory','2026-11-08.md'),'utf8')).length,2,'union is idempotent and does not overwrite same timestamp content');
 const sid=randomUUID();const keep=randomUUID();const session={id:sid,title:'session',messages:[Object.assign(new native.LocalChatMessage(),{syncId:keep,role:'user',text:'keep',at:Date.now()})],modelQueue:[],running:false,updatedAt:Date.now()};fs.writeFileSync(path.join(temp,'sessions',sid+'.json'),JSON.stringify(session));
 const marker=change('CompactMarkerV2','marker',{sessionId:sid,summary:'earlier summary',firstKeptMessageId:keep,compactedCount:3});assert.equal(await MiscReplica.apply(context,marker),true);const saved=await sessionStore.get(context,sid);assert.equal(saved.messages[0].kind,'summary');assert.equal(saved.messages[1].syncId,keep);
 const artifact=change('ArtifactV2','artifact',{artifactId:'artifact',sessionId:sid,title:'Report',currentVersionId:'version-1',mimeType:'text/markdown'});await MiscReplica.apply(context,artifact);assert.equal(collectionStore.items[0].title,'Report');
 const bytes=Buffer.from('# actual report');const hash=createHash('sha256').update(bytes).digest('hex');const assetPath=path.join(temp,'asset-source');fs.writeFileSync(assetPath,bytes);
 const version=change('ArtifactVersionV2','version-1',{artifactId:'artifact',sessionId:sid,originalFileName:'Report.md',mimeType:'text/markdown'});version.record.assets.asset={key:'asset',sha256:hash,size:bytes.length,mimeType:'text/markdown'};
 const transfer={download:async()=>assetPath};assert.equal(await FileReplica.apply(context,version,transfer),true);assert.equal(await MiscReplica.applyVersion(context,version,transfer),true);assert.equal(collectionStore.items[0].body,'# actual report');
 const file=FileReplica.load(context)[0];assert.deepEqual(fs.readFileSync(path.join(temp,'workspace',file.name)),bytes);
 const bad=change('SessionFileV2','bad',{sessionId:sid,relativePath:'../outside'});bad.record.assets.asset=version.record.assets.asset;await assert.rejects(FileReplica.apply(context,bad,transfer),/路径/);
 const tombstone=new protocol.ReplicaChange();tombstone.id=version.id;tombstone.operation='delete';await FileReplica.apply(context,tombstone,transfer);assert.equal(FileReplica.load(context).length,0);assert.equal(fs.existsSync(path.join(temp,'workspace',file.name)),false);
 assert.equal(await MiscReplica.apply(context,change('SyncDeviceV2','device',{})),true);
 console.log('HARMONY_MISC_REPLICA_OK production ETS daily set-union, compaction boundary IDs, artifact/current-version hydration, file bytes, path rejection and tombstones');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
