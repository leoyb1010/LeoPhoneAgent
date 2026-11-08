// Production ETS protocol/transport with explicit native-network and disk adapters.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
const root=new URL('../app/entry/src/main/ets/',import.meta.url);
function load(file,names,env={}){const s=fs.readFileSync(new URL(file,root),'utf8').replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm,'').replace(/\bexport\s+/g,'');const c=vm.createContext({console,...env});vm.runInContext(stripTypeScriptTypes(s,{mode:'strip'})+`\nObject.assign(globalThis,{${names.join(',')}});`,c);return Object.fromEntries(names.map(n=>[n,c[n]]));}
const protocol=load('sync/SyncProtocol.ets',['decodeReplicaPage','normalizeReplicaRoot','recordKey','replicaDate','replicaText','textValue','ReplicaChange','ReplicaRecord','PortableValue']);
assert.equal(protocol.replicaDate(978307200000),0);
for(const bad of ['http://public.example:8080','https://example.test/path','https://user:pass@example.test','http://100.200.1.1:8647'])assert.throws(()=>protocol.normalizeReplicaRoot(bad));
assert.equal(protocol.normalizeReplicaRoot('http://100.91.2.3:8647/'),'http://100.91.2.3:8647');
const replicaId=randomUUID();const now=protocol.replicaDate(Date.now()+10000);
function entry(cursor,type,id,content,operation='upsert'){return {cursor,senderDeviceId:'peer',change:{changeId:randomUUID(),revision:cursor,id:{type,id},operation,updatedAt:now+cursor,record:operation==='delete'?null:{id:{type,id},fields:{contentMarkdown:{t:'string',v:content}},unknownFields:{future:{t:'string',v:'preserve'}},assets:{},schemaVersion:1,minimumCompatibleVersion:1,updatedAt:now+cursor}}};}
const page={replicaId,changes:[entry(1,'SoulV2','soul','remote soul')],nextCursor:1,hasMore:false};
assert.equal(protocol.decodeReplicaPage(JSON.stringify(page),0,'').nextCursor,1);
assert.throws(()=>protocol.decodeReplicaPage(JSON.stringify({...page,nextCursor:2}),0,''),/游标/);
assert.throws(()=>protocol.decodeReplicaPage(JSON.stringify(page),1,randomUUID()),/身份/);
const io={accessSync:fs.existsSync,readTextSync:p=>fs.readFileSync(p,'utf8'),mkdirSync:fs.mkdirSync,statSync:p=>({mtime:fs.statSync(p).mtimeMs/1000})};
const secrets=new Map();const requests=[];const posts=[];let failPost=false;let pages=page.changes;
const http={RequestMethod:{GET:'GET',POST:'POST'},createHttp:()=>({destroy(){},request:async(url,opt)=>{requests.push({url,opt});if(opt.method==='POST'){posts.push(JSON.parse(opt.extraData).changes[0]);if(failPost){failPost=false;throw new Error('network timeout');}const c=posts.at(-1);return{responseCode:200,result:JSON.stringify({receipts:[{changeId:c.changeId,revision:c.revision,status:'stored',cursor:99}]})};}const after=Number(new URL(url).searchParams.get('after'));const changes=pages.filter(e=>e.cursor>after);return{responseCode:200,result:JSON.stringify({replicaId,changes,nextCursor:changes.at(-1)?.cursor??after,hasMore:false})};}})};
const SecretStore={read:async key=>secrets.get(key)||'',write:async(key,value)=>secrets.set(key,value),remove:async key=>{secrets.delete(key);}};
const {BoundSecret}=load('store/BoundSecret.ets',['BoundSecret'],{SecretStore,util:{generateRandomUUID:()=>randomUUID()}});
let failCheckpoint=false;
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'harmony-sync-'));const context={filesDir:temp};
const skills={skills:[],load:async ctx=>{skills.skills=fs.existsSync(path.join(ctx.filesDir,'skills.json'))?JSON.parse(fs.readFileSync(path.join(ctx.filesDir,'skills.json'),'utf8')):[];}};
const {ReplicaSync}=load('sync/ReplicaSync.ets',['ReplicaSync'],{...protocol,BackupAccess:{beginExecution:()=>({release(){}})},BoundSecret,ChatRuns:{anyActive:()=>false},taskStatus:{running:false,pendingWrite:false},
ConfigReplica:{supported:()=>false,capture:async()=>[]},
FileReplica:{supported:()=>false,capture:async()=>[],relink:async()=>{}},
MiscReplica:{supported:()=>false,capture:async()=>[],ensureCollectionSession:async()=>''},
ReplicaAssets:class{async download(){return '';}},
SessionReplica:{supported:()=>false,capture:async()=>[]},fileIo:io,http,util:{generateRandomUUID:randomUUID},atomicWriteText:(p,s)=>{if(failCheckpoint&&p.endsWith('sync-state.json')){const state=JSON.parse(s);if(state.cursor===4&&!state.pendingPageRaw){failCheckpoint=false;throw new Error('checkpoint interrupted');}}fs.writeFileSync(p,s);},SecretStore:{read:async k=>secrets.get(k)||'',write:async(k,v)=>secrets.set(k,v)},soulStore:{load:async()=>{}},memoryStore:{load:async()=>{}},skillStore:skills,LocalSkill:class{}});
try{
 await ReplicaSync.saveConfig(context,'https://replica.test','paired-device','grant-with-sixteen-characters');
 const first=await ReplicaSync.run(context);assert.equal(first.received,1);assert.equal(fs.readFileSync(path.join(temp,'SOUL.md'),'utf8'),'remote soul');
 fs.writeFileSync(path.join(temp,'SOUL.md'),'local edited');failPost=true;
 await assert.rejects(ReplicaSync.run(context),/timeout/);
 assert.equal(fs.readFileSync(path.join(temp,'SOUL.md'),'utf8'),'local edited');
 await ReplicaSync.run(context);assert.equal(posts.length,2);assert.equal(posts[0].changeId,posts[1].changeId);assert.equal(posts[0].revision,posts[1].revision,'retry reuses durable delivery ticket');
 assert.equal(posts[1].record.unknownFields.future.v,'preserve');
 const state=JSON.parse(fs.readFileSync(path.join(temp,'sync-state.json'),'utf8'));assert.equal(state.pending.length,0);
 pages.push(entry(2,'FutureRecordV9','future','opaque'));
 const second=await ReplicaSync.run(context);assert.equal(second.retained,1);
 assert.ok(JSON.parse(fs.readFileSync(path.join(temp,'sync-state.json'),'utf8')).records['FutureRecordV9:future']);
 const malformed=entry(3,'SoulV2','soul','invalid');malformed.change.record.fields.memoryEnabled={t:'int',v:'false'};pages.push(malformed);
 const skipped=await ReplicaSync.run(context);assert.equal(skipped.cursor,3);assert.ok(JSON.parse(fs.readFileSync(path.join(temp,'sync-state.json'),'utf8')).quarantine[replicaId+'/3']);assert.equal(fs.readFileSync(path.join(temp,'SOUL.md'),'utf8'),'local edited','malformed tagged privacy metadata is quarantined');
 pages.push(entry(4,'SoulV2','soul','remote after restart'));failCheckpoint=true;await assert.rejects(ReplicaSync.run(context),/checkpoint/);
 const crashState=JSON.parse(fs.readFileSync(path.join(temp,'sync-state.json'),'utf8'));assert.ok(crashState.pendingPageRaw);assert.equal(crashState.cursor,3);const postedBefore=posts.length;
 const recovered=await ReplicaSync.run(context);assert.equal(recovered.cursor,4);assert.equal(posts.length,postedBefore,'durable inbox replay does not echo an already-applied file');assert.equal(fs.readFileSync(path.join(temp,'SOUL.md'),'utf8'),'remote after restart');
 ReplicaSync.resetCursor(context);await ReplicaSync.run(context);assert.equal(posts.length,postedBefore,'full verification cannot replay older object cursors over a newer winner');
 for(const {url,opt} of requests){assert.ok(url.startsWith('https://replica.test/sync/v1/'));assert.equal(opt.maxRedirects,0);assert.equal(opt.header['X-Leo-Device-ID'],'paired-device');assert.equal(opt.header.Authorization,'Bearer grant-with-sixteen-characters');}
 console.log('HARMONY_SYNC_REPLICA_OK production ETS epoch/wire, origin boundary, cursor identity/order, durable retry, unknown retention, local editing preservation');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
