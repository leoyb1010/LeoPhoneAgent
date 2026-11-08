import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
const root = new URL('../app/entry/src/main/ets/',import.meta.url);
const source = file => fs.readFileSync(new URL(file,root),'utf8');
function load(file,names,env={}) {
  const text=source(file).replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm,'').replace(/\bexport /g,'');
  const context=vm.createContext({console,setTimeout,clearTimeout,...env});
  vm.runInContext(stripTypeScriptTypes(text,{mode:'strip'})+'\nObject.assign(globalThis,{'+names.join(',')+'});',context);
  return Object.fromEntries(names.map(name=>[name,context[name]]));
}
const models=load('remote/RemoteModels.ets',['RemoteCapabilities','RemoteModel','RemoteQuestionRequest','RemoteAttachment']);
const calls=[]; let flags={models:true,model_switch:true,effort:true,compact:true,rename:true,follow:true,ask_user_question:true,attachments:true,automations:true};
const http={RequestMethod:{GET:'GET',POST:'POST',PATCH:'PATCH',DELETE:'DELETE'},createHttp:()=>({destroy(){},async request(url,options){
  calls.push({url,...options});
  let result={ok:true};
  if(url.endsWith('/v1/capabilities')) result={features:flags};
  if(url.endsWith('/harness/sessions')) result={sessions:[{session_id:'s-a',harness:'zcode',status:'running'}]};
  if(url.includes('/diff?')) result={diff:'patch'};
  return {responseCode:200,result:JSON.stringify(result)};
}})};
const network=load('net/HarnessClient.ets',['HarnessClient','ChatLaunch','HttpError'],{
 ...models,http,util:{generateRandomUUID:()=> 'request-id'},harnessURL:(root,m)=>root+'/m/'+m,
 requireHttpsRoot:r=>r,sanitizeKey:k=>k,parseHarnessKinds:()=>[],parseRemoteTasks:()=>[],parseSseData:()=>null,
});
const client=new network.HarnessClient('https://relay.example/api','mini','key');
assert.equal((await client.session('s-a')).harness,'zcode');
await assert.rejects(client.session('missing'),e=>e.code===404);
await client.setModel('s-a','provider','model','high');
assert.deepEqual(JSON.parse(calls.at(-1).extraData),{provider:'provider',model:'model',effort:'high'});
await client.diff('s-a','中文 & x+.ts','checkpoint/one');
assert.ok(calls.at(-1).url.includes('path='+encodeURIComponent('中文 & x+.ts')));
assert.ok(calls.at(-1).url.includes('checkpoint='+encodeURIComponent('checkpoint/one')));
await client.changeAutomation('task/a','enabled',false);
assert.equal(calls.at(-1).method,'PATCH');
assert.equal(calls.at(-1).url.endsWith('/automations/task%2Fa'),true);
assert.deepEqual(JSON.parse(calls.at(-1).extraData),{enabled:false});
await client.closeScreen('scr_fixture');assert.equal(calls.at(-1).method,'DELETE');assert.equal(Object.hasOwn(calls.at(-1),'extraData'),false,'DELETE close follows the iOS body-free contract and cannot append an unframed JSON object');
for(const call of calls){assert.equal(call.maxRedirects,0);assert.equal(call.header.Authorization,'Bearer key');}
flags={};const unsupported=new network.HarnessClient('https://relay.example/api','mini','key');
const before=calls.length;
await assert.rejects(unsupported.compact('s-a'));
assert.equal(calls.length,before+1,'unsupported capability makes only a discovery request');
const question=models.RemoteQuestionRequest.parse({question_id:'q-a',questions:[{question:'Choose',multi_select:true,options:[{label:'a'},{label:'b'}]}]});
assert.deepEqual(Array.from(question.questions[0].labels),['a','b']);

// Run the actual ChatPane private methods, excluding declarative ArkUI build syntax.
const pane=source('panes/ChatPane.ets');
const methods=pane.slice(pane.indexOf('  private async send():'));
const env=vm.createContext({console,...models,...network,router:{pushUrl(){}},RemoteWorkspaceLaunch:{},setTimeout,clearTimeout});
vm.runInContext(stripTypeScriptTypes('class ChatHarness {\n'+methods,{mode:'strip'})+'\nglobalThis.ChatHarness=ChatHarness;',env);
function setup(attachments=[]) {
 const state=new env.ChatHarness();const calls=[];
 Object.assign(state,{draft:'hello',client:{create:async(...a)=>{calls.push(['create',...a]);return 'created';},send:async(...a)=>calls.push(['send',...a])},
 attachments,launchGen:1,machine:'mini',sessionId:'',pendingEcho:[],lines:[],macAuto:false,fullAutoRefused:false,
 sending:false,push(role,text){const line={role,text};this.lines.push(line);return line;},listen(){},reconnects:0});
 network.ChatLaunch.harness='zcode';
 return {state,calls};
}
let test=setup();await test.state.send();
assert.deepEqual(test.calls,[['create','zcode','hello','',false]],'first plain message creates once with prompt and no second send');
test=setup([{name:'photo.jpg',mime:'image/jpeg',data_base64:'aGVsbG8='}]);await test.state.send();
assert.equal(test.calls.length,2);
assert.equal(test.calls[0][2],'','attachment first turn creates with no prompt');
assert.equal(test.calls[1][0],'send');
assert.equal(test.calls[1][2],'hello','one actual send carries text and attachments');
assert.equal(test.calls[1][5].length,1);
test=setup();let release;test.state.client.create=async()=>await new Promise(resolve=>release=resolve);
const pending=test.state.send();test.state.draft='second';await test.state.send();assert.equal(test.state.draft,'second','repeat click keeps next draft');
release('created');await pending;
test=setup();test.state.client.create=async()=>{test.state.draft='new typed text';throw new Error('offline');};await test.state.send();
assert.equal(test.state.draft,'hello\nnew typed text','failed send preserves original and newly typed drafts');
console.log('REMOTE_CONTROLS_OK actual transport capability gate, path encoding, mutations and no-duplicate send flow');

const screens=load('remote/ScreenSessionBridge.ets',['ScreenSessionBridge','ScreenSessionRegistry']);
const bridge=new screens.ScreenSessionBridge();const closed=[];let openResult;
bridge.client={screenPreflight:async()=>({ice_servers:[]}),openScreen:async()=>await new Promise(resolve=>openResult=resolve),closeScreen:async id=>closed.push(id),screenCandidates:async()=>{}};
const oldOpen=bridge.perform('open',{offer:'v=0'});bridge.close();bridge.resume();
openResult({session_id:'scr_old',answer:'answer'});await assert.rejects(oldOpen,/关闭/);
assert.deepEqual(closed,['scr_old'],'late native screen lease closes after page suspend even if page resumed');
assert.equal(bridge.sessionId,'');
await assert.rejects(bridge.perform('ice',{candidates:[]}),/尚未建立/);
await assert.rejects(bridge.perform('https://attacker.example',{offer:'secret'}),/未开放/);
let requestedControl;
bridge.client.openScreen=async(_offer,control)=>{requestedControl=control;return {session_id:'scr_new',answer:'answer'};};
await bridge.perform('open',{offer:'v=0',control:true});
assert.equal(requestedControl,false,'web payload cannot grant native control permission');
await bridge.close();assert.ok(closed.includes('scr_new'));
let releaseClose;bridge.resume();bridge.sessionId='scr_pending';bridge.client.closeScreen=async()=>await new Promise(resolve=>releaseClose=resolve);screens.ScreenSessionRegistry.add(bridge);let settled=false;const suspending=screens.ScreenSessionRegistry.suspend().then(()=>settled=true);await Promise.resolve();assert.equal(settled,false,'suspend waits for actual native DELETE before a diagnostic DNS lease can be removed');releaseClose();await suspending;screens.ScreenSessionRegistry.remove(bridge);
console.log('SCREEN_BRIDGE_OK exact native operation allowlist, no credential bridge, late-lease cleanup and native-only control grant');
