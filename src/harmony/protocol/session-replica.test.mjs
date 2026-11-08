import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
const root=new URL('../app/entry/src/main/ets/',import.meta.url);
function load(file,names,env={}){const s=fs.readFileSync(new URL(file,root),'utf8').replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm,'').replace(/\bexport\s+/g,'');const c=vm.createContext({console,...env});vm.runInContext(stripTypeScriptTypes(s,{mode:'strip'})+`\nObject.assign(globalThis,{${names.join(',')}});`,c);return Object.fromEntries(names.map(n=>[n,c[n]]));}
const protocol=load('sync/SyncProtocol.ets',['ReplicaRecord','ReplicaChange','PortableValue','textValue','replicaDate','replicaText','recordKey','APPLE_EPOCH_MS']);
const chat=load('local/LocalProtocol.ets',['ChatImage','chatImages','LocalChatMessage','ToolCall','LoopTurn','HISTORY_CHAR_BUDGET','trimHistory']);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'harmony-session-sync-'));const context={filesDir:temp};fs.mkdirSync(path.join(temp,'sessions'));
const sessionStore={summaries:[],reload:async()=>{sessionStore.summaries=fs.readdirSync(path.join(temp,'sessions')).map(file=>({id:file.slice(0,-5)}));},get:async(_ctx,id)=>{const p=path.join(temp,'sessions',id+'.json');return fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):null;}};
class LocalSession{constructor(){Object.assign(this,{id:'',title:'new',modelQueue:[],messages:[],updatedAt:0,running:false});}}
const {SessionReplica}=load('sync/SessionReplica.ets',['SessionReplica'],{...protocol,...chat,providerStore:{instances:[]},LocalSession,SessionStore:{validId:id=>/^[a-f0-9-]{36}$/.test(id)},sessionStore,
 ChatRuns:{invalidateIdle(){}},util:{generateRandomUUID:randomUUID},atomicWriteText:(p,s)=>fs.writeFileSync(p,s),fileIo:{accessSync:fs.existsSync,mkdirSync:fs.mkdirSync,unlinkSync:fs.unlinkSync}});
try{
 const sid=randomUUID();const mid=randomUUID();const now=protocol.replicaDate(Date.now());
 const session=new protocol.ReplicaChange();session.id={type:'SessionV2',id:sid};session.updatedAt=now;session.record=new protocol.ReplicaRecord();session.record.id=session.id;session.record.fields.title=protocol.textValue('paired session');
 assert.equal(await SessionReplica.apply(context,session),true);
 const message=new protocol.ReplicaChange();message.id={type:'MessageV2',id:mid};message.updatedAt=now+1;message.record=new protocol.ReplicaRecord();message.record.id=message.id;
 message.record.fields.sessionId=protocol.textValue(sid);message.record.fields.role=protocol.textValue('user');const originalParts=[{type:'text',value:'hello from iOS'},{type:'mediaRef',value:{relativePath:sid+'/photos/a.jpg',mimeType:'image/jpeg'}}];message.record.fields.partsJson=protocol.textValue(JSON.stringify(originalParts));
 assert.equal(await SessionReplica.apply(context,message),true);assert.equal((await sessionStore.get(context,sid)).messages[0].syncId,mid);
 const records=await SessionReplica.capture(context);const wire=records.find(record=>record.id.type==='MessageV2');assert.equal(wire.id.id,mid);assert.deepEqual(JSON.parse(protocol.replicaText(wire,'partsJson')),originalParts,'unchanged media parts survive text projection');
 const repeated=await SessionReplica.capture(context);assert.equal(repeated.find(record=>record.id.type==='MessageV2').id.id,mid,'reopening preserves source message identity');
 const local=await sessionStore.get(context,sid);local.updatedAt=Date.now()+100000;local.messages[0].text='newer local';fs.writeFileSync(path.join(temp,'sessions',sid+'.json'),JSON.stringify(local));
 message.record.fields.partsJson=protocol.textValue('[{"type":"text","value":"older remote"}]');assert.equal(await SessionReplica.apply(context,message),false);assert.equal((await sessionStore.get(context,sid)).messages[0].text,'newer local');
 const edited=await SessionReplica.capture(context);const editedParts=JSON.parse(protocol.replicaText(edited.find(record=>record.id.type==='MessageV2'),'partsJson'));assert.ok(editedParts.some(part=>part.type==='mediaRef'),'editing text retains original media reference');
 assert.equal(await SessionReplica.deleteMessage(context,mid,message.record),true);assert.equal((await sessionStore.get(context,sid)).messages.length,0);
 const historyTools=load('local/AgentText.ets',['TextLine','STOPPED_NOTE','lastSummaryIndex','resumeNote','attachedFilesBlock','summaryWrapper']);
 const {conversationHistory}=load('local/ConversationHistory.ets',['conversationHistory'],{...chat,...historyTools});
 const toolMessages=[{role:'user',text:'read notes',parts:[{type:'text',value:'read notes'}]},{role:'assistant',text:'[工具步骤]',parts:[{type:'toolUse',value:{toolUseId:'call-1',name:'file_read',input:'{\"path\":\"notes.md\"}'}}]},{role:'user',text:'result and note',parts:[{type:'toolResult',value:{toolUseId:'call-1',output:'reference text'}},{type:'text',value:'additional user note'}]}].map(value=>Object.assign(new chat.LocalChatMessage(),{role:value.role,text:value.text,syncText:value.text,syncPartsJson:JSON.stringify(value.parts)}));
 const turns=conversationHistory(toolMessages);assert.deepEqual(Array.from(turns,x=>x.role),['user','assistant','tool','user']);assert.equal(turns[1].calls[0].id,'call-1');assert.equal(turns[2].toolCallId,'call-1');assert.equal(turns[2].content,'reference text');
 console.log('HARMONY_SESSION_REPLICA_OK production ETS iOS ContentPart wire, session hydration, stable source IDs, local-newer protection, message tombstone');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
