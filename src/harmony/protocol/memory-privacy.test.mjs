import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
const root=new URL('../app/entry/src/main/ets/',import.meta.url);
function load(file,names,env={}){const s=fs.readFileSync(new URL(file,root),'utf8').replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm,'').replace(/\bexport\s+/g,'');const c=vm.createContext({console,...env});vm.runInContext(stripTypeScriptTypes(s,{mode:'strip'})+`\nObject.assign(globalThis,{${names.join(',')}});`,c);return Object.fromEntries(names.map(n=>[n,c[n]]));}
const extra={...load('local/ExtraToolSchemas.ets',['extraToolSchemas']),...load('local/MailTools.ets',['mailToolSchemas'])};
const names=['LoopTurn','ToolCall','localToolSchemaJson','anthropicToolSchemaJson','geminiToolSchemaJson','responsesToolSchemaJson','responsesBodyJson','usesCodexResponses','CODEX_RESPONSES_URL','requireProviderRoot','providerWire','chatCompletionsUrl','anthropicMessagesUrl','geminiStreamUrl','anthropicMessagesJson','geminiContentsJson','wireMessagesJson','toolArg','toolArgsComplete'];
const protocol=load('local/LocalProtocol.ets',names,extra);
const base=JSON.parse(protocol.localToolSchemaJson()).map(tool=>tool.function.name);assert.ok(base.includes('memory_get')&&base.includes('memory_write'));
for(const raw of [protocol.localToolSchemaJson(false),protocol.anthropicToolSchemaJson(false),protocol.geminiToolSchemaJson(false),protocol.responsesToolSchemaJson(false)])assert.ok(!raw.includes('"memory_get"')&&!raw.includes('"memory_write"'));
const mediaModels=load('local/ProviderModels.ets',['modelImageMode']);
const {OpenAICompatClient}=load('local/OpenAICompatClient.ets',['OpenAICompatClient'],{...protocol,...mediaModels});
for(const [type,credential,url] of [['custom','apiKey','https://provider.test/v1'],['anthropic','apiKey','https://anthropic.test/v1'],['gemini','apiKey','https://gemini.test/v1beta'],['openAI','oauth','https://chatgpt.com']]){
 const client=new OpenAICompatClient(url,'TEST_KEY','model',type,credential,'','session');const turn=new protocol.LoopTurn();turn.content='hello';
 const payload=client.payload([turn],'system','',true,false);assert.ok(!payload.includes('"memory_get"')&&!payload.includes('"memory_write"'),type);JSON.parse(payload);
}
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'harmony-memory-privacy-'));const context={filesDir:temp};fs.mkdirSync(path.join(temp,'sessions'));const io={accessSync:fs.existsSync,readTextSync:p=>fs.readFileSync(p,'utf8')};
const {SessionStore}=load('store/SessionStore.ets',['SessionStore'],{fileIo:io});
try{
 const file=path.join(temp,'sessions','s_1_2.json');fs.writeFileSync(file,'{"memoryEnabled":false}');assert.equal(SessionStore.memoryAllowed(context,'s_1_2'),false);
 fs.writeFileSync(file,'{}');assert.equal(SessionStore.memoryAllowed(context,'s_1_2'),true,'legacy sessions preserve default memory behavior');fs.writeFileSync(file,'invalid');assert.equal(SessionStore.memoryAllowed(context,'s_1_2'),false,'unreadable privacy state fails closed');
 let enabled=true;let release;let reads=0,writes=0;
 const memoryStore={promptBlock:()=> 'PRIVATE_MEMORY',load:()=>new Promise(resolve=>{release=resolve;}),search:()=>{reads++;return 'PRIVATE_MEMORY';},appendToday:async()=>writes++};
 const empty={promptBlock:()=>''};
 const {LocalTools}=load('local/LocalTools.ets',['LocalTools'],{BackupAccess:{beginExecution:()=>({release(){}})},...protocol,memoryStore,Copy:{linuxRuntime:''},nowLine:()=>'',SensitiveToolGate:{fullAuto:false,unattendedDenial:()=>'',bindArguments:async()=>true,requiresPersonalRead:()=>false},soulStore:empty,skillStore:empty,collectionStore:empty,mcpStore:empty,envStore:{...empty,referenced:()=>false,expand:x=>x},envAllowedTool:()=>false});
 assert.ok(LocalTools.systemPrompt(true).includes('PRIVATE_MEMORY'));assert.ok(!LocalTools.systemPrompt(false).includes('PRIVATE_MEMORY'));
 const read=LocalTools.run(context,'memory_get','{"scope":"all"}','s_1_2',false,()=>true,()=>enabled);for(let i=0;i<5&&!release;i++)await Promise.resolve();enabled=false;release();release=undefined;const denied=await read;assert.equal(reads,0);assert.match(denied.text,/关闭|取消/);
 enabled=true;const write=LocalTools.run(context,'memory_write','{"content":"do not save"}','s_1_2',false,()=>true,()=>enabled);for(let i=0;i<5&&!release;i++)await Promise.resolve();enabled=false;release();release=undefined;await write;assert.equal(writes,0);
 console.log('HARMONY_MEMORY_PRIVACY_OK production ETS four wire schemas/payloads, prompt exclusion, persisted legacy semantics and post-await read/write revocation');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
