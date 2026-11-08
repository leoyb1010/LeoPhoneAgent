// Executes actual engine/child/native-side-effect code with controlled permission continuations.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
const root=new URL('../app/entry/src/main/ets/',import.meta.url);
function load(file,names,env={}){const s=fs.readFileSync(new URL(file,root),'utf8').replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm,'').replace(/\bexport\s+/g,'');for (const method of ['revokeOperation','forgetSession','beginOperation']) { if (env.SensitiveToolGate && !env.SensitiveToolGate[method]) env.SensitiveToolGate[method]=()=>{}; }
  const c=vm.createContext({WearTools:{cancelOwner(){}},SessionStore:{memoryAllowed:()=>true},LinuxRuntime:{cancelOwner(){}},MailTools:{cancel(){}},console,setTimeout,clearTimeout,...env});vm.runInContext(stripTypeScriptTypes(s,{mode:'strip'})+`\nObject.assign(globalThis,{${names.join(',')}});`,c);return Object.fromEntries(names.map(n=>[n,c[n]]));}
let releasePermission;let releaseNotification;let effects=0;let fastKind='toggleFlashlight';
const {FastLocalActions}=load('local/FastLocalActions.ets',['FastLocalActions'],{
 SensitiveToolGate:{load:async()=>{},unattendedDenial:()=>''},
 abilityAccessCtrl:{createAtManager:()=>({requestPermissionsFromUser:()=>new Promise(resolve=>{releasePermission=resolve;})})},
 camera:{getCameraManager:()=>({isTorchSupported:()=>true,setTorchMode:()=>effects++}),TorchMode:{ON:1,OFF:0}},
 notificationManager:{requestEnableNotification:()=>new Promise(resolve=>{releaseNotification=resolve;}),publish:async()=>effects++,ContentType:{NOTIFICATION_CONTENT_BASIC_TEXT:0}},
 reminderAgentManager:{publishReminder:async()=>effects++,ReminderType:{REMINDER_TYPE_ALARM:0},ActionButtonType:{ACTION_BUTTON_TYPE_CLOSE:0}},
 taskStatus:{setTorchOn(){},setLastTodo(){}},ActionRouter:{decide:()=>({path:'native',kind:fastKind,label:'on'}),spoken:()=>'',receipt:()=>'',failureReceipt:()=>''},
});
let alive=true;
const torch=FastLocalActions.setTorch({},true,()=>alive);alive=false;releasePermission({authResults:[0]});assert.equal(await torch,false);assert.equal(effects,0);
alive=true;const alarm=FastLocalActions.addAlarm({}, {hour:12,minute:0,label:'test'},()=>alive);alive=false;releasePermission({authResults:[0]});assert.equal(await alarm,false);assert.equal(effects,0);
alive=true;const notice=FastLocalActions.postNotice('test','text',()=>alive);alive=false;releaseNotification();assert.equal(await notice,false);assert.equal(effects,0);
alive=true;const fastRoute=FastLocalActions.tryRoute({},'开灯',0,false,()=>alive);alive=false;releasePermission({authResults:[0]});await fastRoute;assert.equal(effects,0,'direct fast path preserves the cancellation context');
alive=true;const valid=FastLocalActions.setTorch({},true,()=>alive);releasePermission({authResults:[0]});assert.equal(await valid,true);assert.equal(effects,1,'a current action still executes normally');
fastKind='createCalendar';assert.equal(await FastLocalActions.tryRoute({},'明天创建日历',0,false), '');assert.equal(effects,1,'calendar intent must use actual CalendarKit approval path');
const shared={cancelOwner(){}};
const p=load('local/LocalProtocol.ets',['ToolLoopGuard','LoopTurn']);
const {LocalAgentEngine}=load('local/LocalAgentEngine.ets',['LocalAgentEngine'],{
 ...p,SubAgentTasks:shared,taskStatus:{setRunning(){}},FastLocalActions:{tryRoute:async()=>''},
 providerStore:{ensureLoaded:async()=>{},configured:()=>true,queue:()=>[],captureQueue:()=>[]},SensitiveToolGate:{load:async()=>{}},
});
const {SubAgentTasks}=load('local/SubAgentTasks.ets',['SubAgentTasks'],{LocalAgentEngine,util:{generateRandomUUID:randomUUID}});
shared.cancelOwner=owner=>SubAgentTasks.cancelOwner(owner);
const parent=LocalAgentEngine.bump('owner');
const result=SubAgentTasks.run({},'owner','child task',()=>LocalAgentEngine.current('owner')===parent).catch(error=>error);
LocalAgentEngine.bump('owner');const cancelled=await result;assert.match(cancelled.message,/停止|取消/);
assert.equal(SubAgentTasks.tasks.size,0,'bump removes all old-generation child tasks');
let started=0;const priorRun=LocalAgentEngine.run;LocalAgentEngine.run=()=>{started++;};
await assert.rejects(SubAgentTasks.run({},'owner','stale task',()=>false),/停止/);assert.equal(started,0);
LocalAgentEngine.run=priorRun;
console.log('HARMONY_NATIVE_CANCELLATION_OK actual ETS permission-wait stop, notify/reminder/torch admission, direct fast route, generation-bump child cancellation');
