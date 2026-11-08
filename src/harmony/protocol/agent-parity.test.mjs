// Executes production ETS logic. Network, native IO and UI are explicit adapters.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
const root = new URL('../app/entry/src/main/ets/', import.meta.url);
function load(file, names, env = {}) {
  const source = fs.readFileSync(new URL(file, root), 'utf8')
    .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '').replace(/\bexport\s+/g, '');
  for (const method of ['revokeOperation','forgetSession','beginOperation']) { if (env.SensitiveToolGate && !env.SensitiveToolGate[method]) env.SensitiveToolGate[method]=()=>{}; }
  const context = vm.createContext({WearTools:{cancelOwner(){}}, SessionStore:{memoryAllowed:()=>true}, LinuxRuntime:{cancelOwner(){}},MailTools:{cancel(){}}, console, setTimeout, clearTimeout, ...env });
  vm.runInContext(stripTypeScriptTypes(source, { mode: 'strip' }) + `\nObject.assign(globalThis, {${names.join(',')}});`, context, { filename: file });
  return Object.fromEntries(names.map(name => [name, context[name]]));
}
const extra = { ...load('local/ExtraToolSchemas.ets', ['extraToolSchemas']), ...load('local/MailTools.ets', ['mailToolSchemas']) };
const protocol = load('local/LocalProtocol.ets', ['ChatImage','chatImages','FailoverSlot', 'ProviderSlot', 'resolveFailoverQueue', 'ToolLoopGuard',
  'LoopTurn', 'LocalChatMessage', 'localToolSchemaJson', 'stableModelIndex'], { ...extra, util:{TextEncoder:class{encodeInto(value){return new TextEncoder().encode(value);}}} });
for(const seed of ['', 'same-session', '会话🙂', 'deadbeef-1234-5678-90ab-cdef12345678']){let hash=0xcbf29ce484222325n;for(const value of new TextEncoder().encode(seed))hash=BigInt.asUintN(64,(hash^BigInt(value))*0x100000001b3n);for(const count of [2,3,7,37,101])assert.equal(protocol.stableModelIndex(seed,count),Number(hash%BigInt(count)));}
const {ProviderStore, ProviderInstance, ProviderRunSlot, ModelGroup} = load('store/ProviderStore.ets', ['ProviderStore', 'ProviderInstance', 'ProviderRunSlot', 'ModelGroup'], {
  AtomicTextFile: class {}, chatModelsFor: (_, ids) => ids, ...protocol,
});
const providers = new ProviderStore();
const row = new ProviderInstance(); Object.assign(row, { id: 'p', model: 'chosen', models: ['chosen', 'manual'], deletedModels: ['removed'] });
providers.applyModels(row, ['new', 'removed']);
assert.deepEqual(Array.from(row.models), ['chosen', 'manual', 'new']);
assert.equal(row.model, 'chosen');
providers.applyModels(row, []);
assert.deepEqual(Array.from(row.models), ['chosen', 'manual', 'new']);
providers.applyModels(row, ['new', 'next']);
assert.deepEqual(Array.from(row.models), ['chosen', 'manual', 'new', 'next']);
const a = new protocol.ProviderSlot(); Object.assign(a, { id: 'stable-a', label: 'same/name', model: 'default-a' });
const b = new protocol.ProviderSlot(); Object.assign(b, { id: 'stable-b', label: 'same/name', model: 'default-b' });
let queue = protocol.resolveFailoverQueue('stable-a', [a, b], ['stable-b/brand/model']);
assert.equal(queue[0].instanceId, 'stable-b'); assert.equal(queue[0].model, 'brand/model');
a.label = 'renamed';
queue = protocol.resolveFailoverQueue('stable-a', [a], ['stable-a/brand/model']);
assert.equal(queue[0].model, 'brand/model');
queue = protocol.resolveFailoverQueue('stable-a', [a], ['renamed/brand/model']);
assert.equal(queue[0].model, 'brand/model', 'legacy group reference remains supported');
const {SessionStore, LocalSession} = load('store/SessionStore.ets', ['SessionStore', 'LocalSession'], protocol);
assert.equal(SessionStore.validId('s_123_456'),true);
assert.equal(SessionStore.validId('deadbeef-1234-5678-90ab-cdef12345678'),true);
for(const bad of ['../x','s_1_2/../../x','deadbeef-../../x','', '/tmp/x']) assert.equal(SessionStore.validId(bad),false);
const sessions = new SessionStore(); const session = new LocalSession(); session.id = 's';
sessions.get = async () => session; sessions.persist = () => {};
await sessions.bindModels({}, 's', queue); queue[0].model = 'changed';
assert.equal(session.modelQueue[0].model, 'brand/model', 'binding copies caller slots');
sessions.persist = () => { throw new Error('disk full'); };
await assert.rejects(sessions.bindModels({}, 's', []), /disk full/);
assert.equal(session.modelQueue[0].model, 'brand/model', 'failed persistence restores binding');
const {ChatRun, ChatRuns} = load('local/ChatRun.ets', ['ChatRun', 'ChatRuns'], {
  ...protocol, SubAgentTasks: { cancelOwner() {} },
});
let writes = 0, enter;
const wait = new Promise(resolve => {enter = resolve;});
const run = new ChatRun({}, 's');
run.sendMessage = async () => { writes++; await wait; };
const first = run.send('hello', null, [], '');
await run.send('hello', null, [], ''); assert.equal(writes, 1, 'concurrent send is admitted once');
enter(); await first;
run.active = true; await run.send('hello', null, [], ''); assert.equal(writes, 1);
// Capture full endpoint/credential pairs from the real provider store.
providers.instances = [row]; providers.effectiveRoot = ()=>'https://original.test'; providers.keyFor=()=> 'original-key';
const captured = providers.captureQueue([{instanceId:'p',model:'chosen'}]);
providers.effectiveRoot=()=> 'https://changed.test'; providers.keyFor=()=> 'changed-key';
assert.equal(captured[0].root,'https://original.test'); assert.equal(captured[0].key,'original-key');
const group = new ModelGroup(); group.id='g'; group.strategy='loadBalance'; group.fallbackStrategy='always'; group.modelIds=['p/one','p/two'];
providers.groups=[group]; providers.activeGroupId='g';
const same=providers.queue('same-session');assert.equal(providers.queue('same-session')[0].model,same[0].model);
assert.equal(same[0].fallbackAlways,true);
const assigned=new Set(['a','b','c','d'].map(id=>providers.queue(id)[0].model));assert.equal(assigned.size,2,'load balance distributes sessions while preserving each binding');
const states = [];
const clients = [];
const providerStore = {
  instances:[{id:'p',enabled:true},{id:'q',enabled:true},{id:'x',enabled:true}],
  ensureLoaded: async () => {}, configured: () => true,
  queue: () => [{instanceId:'p', model:'first'}, {instanceId:'q',model:'backup'}],
  captureQueue: slots => slots.map(slot => ({...slot,root:'https://example.test',key:'test',type:'custom',credential:'apiKey',reference:'generation-1'})),
  keyFor: () => 'test', slotRoot: () => 'https://example.test', slotType: () => 'custom', slotCredential: () => 'apiKey',
};
const {LocalAgentEngine} = load('local/LocalAgentEngine.ets', ['LocalAgentEngine'], {
  ...protocol, providerStore,
  taskStatus: {setRunning: value => states.push(value)},
  SensitiveToolGate: {load: async()=>{}},
  FastLocalActions: {tryRoute: async()=>''}, LocalTools:{systemPrompt:()=>''},
  SubAgentTasks: {cancelOwner(){}}, MAX_TOOL_ROUNDS:32,
  OpenAICompatClient:{open:async (_root,_key,model,_type,_credential,_instance,session,reference)=>({streamTurn:(_turns,_system,_thinking,delta,done,error)=>{
    const client={model,session,reference,root:_root,key:_key,delta,done,error,destroyed:0,destroy(){this.destroyed++;}};clients.push(client);return client;
  }})}, shouldFailover:()=>true,
});
const generation = LocalAgentEngine.bump('parent');
await LocalAgentEngine.begin({}, 'parent', generation, [], '', 5, 0, ()=>{}, ()=>{}, ()=>{});
assert.equal(clients[0].model,'first'); assert.equal(clients[0].session,'parent'); assert.equal(clients[0].reference,'generation-1');
providerStore.queue=()=>[{instanceId:'x',model:'new-global'}];
await LocalAgentEngine.begin({}, 'parent', generation, [], '', 6, 1, ()=>{}, ()=>{}, ()=>{});
assert.equal(clients[1].model,'backup','tool round uses captured queue');
// A delayed callback from the stopped request must never release a restarted request.
const old = clients[1];
LocalAgentEngine.stop('parent');
const restarted = LocalAgentEngine.bump('parent');
await LocalAgentEngine.begin({}, 'parent', restarted, [], '', 0, 0, ()=>{}, ()=>{}, ()=>{});
const freshRequest = clients[2];
old.done({text:'late success',calls:[]});
old.error('late error');
await new Promise(resolve=>setTimeout(resolve,10));
assert.equal(freshRequest.destroyed,0,'late old callbacks preserve new native request');
assert.equal(LocalAgentEngine.reqs.get('parent'),freshRequest);
LocalAgentEngine.forget('parent');
const afterForget = LocalAgentEngine.bump('parent');
assert.ok(afterForget > restarted,'evicting a session cannot reuse a generation');
const before=states.length;
const childGeneration=LocalAgentEngine.bump('subagent:child');
await LocalAgentEngine.begin({}, 'subagent:child', childGeneration, [], '', 0, 0, ()=>{}, ()=>{}, ()=>{});
LocalAgentEngine.stop('subagent:child'); assert.equal(states.length,before,'child cannot clear parent running status');
let subEnv={};
const childRuns=[]; const cancelled=[];
const {SubAgentTasks} = load('local/SubAgentTasks.ets',['SubAgentTasks'], {
 util:{generateRandomUUID:()=>String(childRuns.length)},
 LocalAgentEngine:{bump:()=>1, run:(_ctx,id,_gen,prompt,_thinking,_delta,done,error)=>childRuns.push({id,prompt,done,error}),
 stop:id=>cancelled.push(id),forget(){}},
});
await assert.rejects(SubAgentTasks.run({},'subagent:nested','task'),/不能/);
const pending=SubAgentTasks.run({},'owner','read-only analysis');
childRuns[0].done('result');assert.equal(await pending,'result');
const aborted=SubAgentTasks.run({},'owner','another task');
SubAgentTasks.cancelOwner('different');assert.equal(cancelled.length,1);
SubAgentTasks.cancelOwner('owner');await assert.rejects(aborted,/取消/);
assert.equal(cancelled.length,2);
assert.ok(JSON.parse(protocol.localToolSchemaJson()).some(tool=>tool.function.name==='subagent'));
console.log('HARMONY_AGENT_PARITY_OK actual ETS model merge, stable group references, persistent binding, send admission, fixed turn queue, child isolation/cancellation');
