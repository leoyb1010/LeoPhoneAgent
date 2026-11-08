// Execute the production ETS transport with a stateful separate-pipe adapter. Real guest proof is a separate native probe.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';
const root=new URL('../app/entry/src/main/ets/',import.meta.url);
function load(file,names,env={}) {
 const source=fs.readFileSync(new URL(file,root),'utf8').replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm,'').replace(/\bexport /g,'');
 const context=vm.createContext({console,setTimeout,clearTimeout,Date,ArrayBuffer,Uint8Array,...env});
 vm.runInContext(stripTypeScriptTypes(source,{mode:'strip'})+'\nObject.assign(globalThis,{'+names.join(',')+'});',context);
 return Object.fromEntries(names.map(name=>[name,context[name]]));
}
const sessions=new Map();let starts=0,detaches=0,initializeCount=0,pingReplies=0;
const cancellations=[];const startup=[];
const runtime={initialize:async()=>{},run:async()=>({exitCode:0}),
 startStdio(owner,command){const id=++starts;const marker=/LEO_MCP_READY_[A-Za-z0-9-]+/.exec(command)[0];startup.push(command);sessions.set(id,{owner,output:'shell warning\n'+marker+'\n',input:'',ready:false,count:0});return id;},
 poll(owner,id){const session=sessions.get(id);assert.equal(session.owner,owner);const text=session.output+(session.flood ? session.flood() : '');session.output='';return {text,stderr:'{\"jsonrpc\":\"2.0\",\"id\":103,\"result\":{\"count\":999}}\n',stderrTruncated:false,exited:false,truncated:false,exitCode:0};},
 writeStdio(owner,id,text){const session=sessions.get(id);assert.equal(session.owner,owner);if(session.blockWrites)return 0;session.input+=text;while(session.input.includes('\n')){
  const at=session.input.indexOf('\n'),line=session.input.slice(0,at);session.input=session.input.slice(at+1);
  if(!session.ready){session.executable=Buffer.from(line,'base64').toString();session.ready=true;continue;}
  const message=JSON.parse(line);
  // True pipes never echo stdin. Server-originated requests may legally reuse client request IDs.
  if(message.method===undefined && message.result){pingReplies++;continue;}
  if(message.method==='initialize'){initializeCount++;session.output+=JSON.stringify({jsonrpc:'2.0',id:message.id,result:{protocolVersion:'2025-06-18',capabilities:{},serverInfo:{name:'fixture',version:'1'}}})+'\n';}
  else if(message.method==='tools/list'){session.output+=JSON.stringify({jsonrpc:'2.0',id:message.id,result:{tools:[{name:'counter',inputSchema:{type:'object'}}]}})+'\n';}
  else if(message.method==='tools/call'){
   const count=++session.count;
   if(message.params.name==='wait')continue;
   // Unadvertised sampling gets an error, while a same-id base-protocol ping gets an empty result.
   session.output+=JSON.stringify({jsonrpc:'2.0',id:message.id,method:'sampling/createMessage',params:{}})+'\n';
   session.output+=JSON.stringify({jsonrpc:'2.0',id:message.id,method:'ping',params:{}})+'\n';
   setTimeout(()=>{session.output+=JSON.stringify({jsonrpc:'2.0',id:message.id,result:{count}})+'\n';},message.params.name==='slow'?90:5);
  }else if(message.method==='notifications/cancelled'){cancellations.push(message.params.requestId);}
 }return new TextEncoder().encode(text).length;},detach:async(owner,id)=>{assert.equal(sessions.get(id).owner,owner);sessions.delete(id);detaches++;}};
const util={generateRandomUUID:()=>randomUUID(),TextEncoder:class{encodeInto(s){return new TextEncoder().encode(s);}},Base64Helper:class{encodeToStringSync(bytes){return Buffer.from(bytes).toString('base64');}}};
const cryptoFramework={createMd:()=>{let hash=createHash('sha256');return{update:async data=>hash.update(data.data),digest:async()=>({data:new Uint8Array(hash.digest())})};}};
const protocol={mcpRequest:(id,method,params)=>JSON.stringify({jsonrpc:'2.0',id,method,params:JSON.parse(params)}),mcpInitializeParams:()=>JSON.stringify({protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'fixture',version:'1'}}),mcpNotification:method=>JSON.stringify({jsonrpc:'2.0',method})};
const module=load('local/McpStdio.ets',['McpStdio','McpStdioSpec','stdioExec','stdioQuote'],{LinuxRuntime:runtime,util,cryptoFramework,...protocol,ReleaseCatalog:{currentVersion:'1'},AppStorage:{setOrCreate(){}}});
module.McpStdio.attachContext({filesDir:'/fixture'});
const spec=new module.McpStdioSpec();Object.assign(spec,{label:'fixture',command:'/bin/sh',args:['-c','counter'],env:{API_KEY:'SECRET"\nvalue'}});
assert.ok(module.stdioExec(spec).includes("'API_KEY=SECRET\"\nvalue'"));
assert.throws(()=>module.stdioQuote('bad\0value'));
try{
 const list=await module.McpStdio.request(spec,'tools/list','{}',1000);assert.equal(JSON.parse(list).result.tools[0].name,'counter');
 const slow=module.McpStdio.request(spec,'tools/call',JSON.stringify({name:'slow',arguments:{}}),1000);
 const fast=module.McpStdio.request(spec,'tools/call',JSON.stringify({name:'fast',arguments:{}}),1000);
 const replies=await Promise.all([slow,fast]);assert.deepEqual(replies.map(reply=>JSON.parse(reply).result.count),[1,2]);
 assert.equal(starts,1,'tools/list and concurrent calls reuse one actual session');for(let tick=0;tick<20&&pingReplies<2;tick++)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(pingReplies>=2,'server pings are answered without satisfying same-id client calls');assert.equal(initializeCount,1,'initialize once per persistent server');
 assert.equal(startup[0].includes('SECRET'),false,'startup command contains no runtime environment secrets');
 assert.ok([...sessions.values()][0].executable.includes('SECRET'),'secrets delivered only after no-echo marker');
 let current=true;
 const cancelled=module.McpStdio.request(spec,'tools/call',JSON.stringify({name:'wait',arguments:{}}),1000,()=>current);
 await new Promise(resolve=>setTimeout(resolve,40));current=false;await assert.rejects(cancelled,/取消/);
 const after=await module.McpStdio.request(spec,'tools/call',JSON.stringify({name:'fast',arguments:{}}),1000);
 assert.equal(JSON.parse(after).result.count,4,'cancelling one call preserves server state and other callers');assert.equal(starts,1);
 await assert.rejects(module.McpStdio.request(spec,'tools/call',JSON.stringify({name:'wait',arguments:{}}),40),/超时/);
 await new Promise(resolve=>setTimeout(resolve,50));assert.ok(cancellations.length>=2,'cancel and timeout send MCP cancellation notifications');
 assert.equal(module.McpStdio.running('fixture'),true);
 module.McpStdio.closeLabel('fixture');assert.equal(detaches,1);assert.equal(module.McpStdio.running('fixture'),false);
 // A server may continue making client requests while never reading client responses.
 const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
 async function startPressure(label) {
  const definition = new module.McpStdioSpec();
  Object.assign(definition,{label,command:'/bin/sh',args:['-c',label],env:{}});
  await module.McpStdio.request(definition,'tools/list','{}',1000);
  const session = [...sessions.values()].at(-1);
  const process = [...module.McpStdio.processes.values()].find(item=>item.spec.label===label);
  // Keep the read pump at 20ms while the server never completes this call.
  const pending = module.McpStdio.request(definition,'tools/call',JSON.stringify({name:'wait',arguments:{}}),10000);
  const rejected = pending.then(()=>assert.fail('pressure call must fail'),error=>error);
  await sleep(30);session.blockWrites=true;
  session.output+=JSON.stringify({jsonrpc:'2.0',id:'blocked-response',method:'ping'})+'\n';
  while(!process.sending)await sleep(5);
  assert.ok(process.queuedFrames>0,'active backpressured frame remains reserved');
  return {session,process,rejected};
 }
 const entries = await startPressure('entry-pressure');
 entries.session.flood=()=>Array.from({length:1000},(_,id)=>JSON.stringify({jsonrpc:'2.0',id,method:'ping'})+'\n').join('');
 assert.match((await entries.rejected).message,/配额/);
 assert.equal(entries.process.stopped,true);assert.equal(entries.process.queuedFrames,0);
 assert.equal(module.McpStdio.queuedFrames,0,'overflow releases queued and active reservations once');
 const bytes = await startPressure('byte-pressure');
 const largeId='x'.repeat(2*1024*1024);
 bytes.session.flood=()=>JSON.stringify({jsonrpc:'2.0',id:largeId,method:'ping'})+'\n';
 assert.match((await bytes.rejected).message,/配额/);
 assert.equal(bytes.process.stopped,true);assert.equal(module.McpStdio.queuedBytes,0);
 const globalEntries=[];for(const label of ['frames-a','frames-b','frames-c'])globalEntries.push(await startPressure(label));
 for(const item of globalEntries){let emitted=false;item.session.flood=()=>{if(emitted)return '';emitted=true;return Array.from({length:100},(_,id)=>JSON.stringify({jsonrpc:'2.0',id,method:'ping'})+'\n').join('');};}
 assert.match((await Promise.race(globalEntries.map(item=>item.rejected))).message,/配额/);
 assert.ok(globalEntries.filter(item=>!item.process.stopped).every(item=>item.process.queuedFrames<128),'global frame quota triggers before any individual frame quota');
 module.McpStdio.closeAll();await Promise.all(globalEntries.map(item=>item.rejected));await sleep(20);
 assert.equal(module.McpStdio.queuedFrames,0);
 const global=[];for(const label of ['global-a','global-b','global-c'])global.push(await startPressure(label));
 for(const item of global)item.session.flood=()=>JSON.stringify({jsonrpc:'2.0',id:largeId,method:'ping'})+'\n';
 const firstFailure=await Promise.race(global.map(item=>item.rejected));
 assert.match(firstFailure.message,/配额/);
 assert.ok(global.filter(item=>item.process.stopped).length>0,'global overflow closes an offending server');
 assert.ok(global.filter(item=>!item.process.stopped).every(item=>item.process.queuedBytes<32*1024*1024),'global byte quota triggers before any individual byte quota');
 assert.ok(module.McpStdio.queuedBytes<=64*1024*1024);
 assert.ok(module.McpStdio.queuedFrames<=256);
 module.McpStdio.closeAll();await Promise.all(global.map(item=>item.rejected));
 await sleep(30);assert.equal(module.McpStdio.queuedBytes,0);assert.equal(module.McpStdio.queuedFrames,0);
 console.log('MCP_STDIO_PRESSURE_OK real ETS server request flood, unread stdin, per-server/global byte+frame quotas, active reservation and exact release');
 console.log('MCP_STDIO_ACTUAL_ETS_OK persistent process, initialize once, reversed concurrent replies, separate-stream isolation and bidirectional ping IDs, cancel/timeout demux, environment injection and detach');
}finally{module.McpStdio.closeAll();}
