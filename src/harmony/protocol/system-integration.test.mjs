// Actual ETS decisions with injected SDK services. Native compilation/device checks are separate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { randomUUID } from 'node:crypto';
const root = new URL('../app/entry/src/main/ets/', import.meta.url);
function load(file, symbols, env = {}) {
  const source = fs.readFileSync(new URL(file, root), 'utf8')
    .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')
    .replace(/export default /g, '').replace(/\bexport /g, '');
  const context = vm.createContext({ console, setTimeout, clearTimeout, AppStorage: {setOrCreate(){}}, ...env });
  vm.runInContext(stripTypeScriptTypes(source, {mode:'strip'}) + '\nObject.assign(globalThis, {' + symbols.join(',') + '});', context);
  return Object.fromEntries(symbols.map(s => [s, context[s]]));
}
const slots = new Map();
const statuses = [];
const artifacts = [];
let enabled = false;
let authorize = async () => enabled;
let starts = 0;
let stopped = 0;
let completion;
const api = load('agentextension/LeoAgentAbility.ets', ['LeoAgentAbility'], {
  AgentExtensionAbility: class { context = {agentCard:{}}; },
  createA2AServer(_card, callback) { return {callback, start(){},stop(){},
    updateStatus(id,s){statuses.push([id,s]);},addArtifact(id,a){artifacts.push([id,a]);}}; },
  BackupStore: {beginExecution:()=>({release(){}})},
  AgentSettings: {enabled: async()=>await authorize()},
  AgentOperation: {EXECUTE:0,CANCEL:1,CLEAR_CONTEXT:2},
  TaskState: {WORKING:1,COMPLETED:3,CANCELED:4,FAILED:5,REJECTED:6,AUTH_REQUIRED:7},
  Role:{AGENT:0}, util:{generateRandomUUID: ()=>randomUUID()},
  LocalTools:{hydrate:async()=>{}}, providerStore:{ensureLoaded:async()=>{}},
  sessionStore:{create:async()=>({id:'local'}),append:async()=>{}},
  LocalAgentEngine:{bump:k=>{slots.set(k,1);return 1;},run(_c,_k,_g,_p,_t,_d,done){starts++;completion=done;},
    stop(){stopped++;},forget(){}},
});
const agent = new api.LeoAgentAbility();
agent.onCreate({});
const request=(id, caller='caller')=>({getTaskId:()=>id,getAgentId:()=>caller,getUserInput:()=> 'hello'});
await agent.dispatch('Execute', request('a'));
assert.equal(statuses.at(-1)[1].state,7,'external agent needs local opt-in');
assert.equal(starts,0);
enabled = true;
await agent.dispatch('Execute',request('a'));
assert.equal(starts,1);
await agent.dispatch('Execute',request('a'));
assert.equal(starts,1,'duplicate execute cannot repeat effects');
await agent.dispatch('Cancel',request('a','attacker'));
assert.equal(stopped,0,'another caller cannot cancel task');
await agent.dispatch('Cancel',request('a'));
assert.equal(stopped,1);
completion('late');
await new Promise(resolve=>setImmediate(resolve));
assert.equal(artifacts.length,0,'late result after cancellation stays hidden');
await agent.dispatch('Execute',request('b'));
completion('answer');
await new Promise(resolve=>setImmediate(resolve));
assert.equal(artifacts[0][1].parts[0].text,'answer');
assert.equal(statuses.at(-1)[1].state,3);
// Reserve before the deferred authorization read, including duplicate and early-cancel interleavings.
const raceAgent = new api.LeoAgentAbility(); raceAgent.onCreate({});
let releaseAuthorization;
authorize = async () => await new Promise(resolve => { releaseAuthorization = resolve; });
const beforeRaceStarts = starts;
const firstRace = raceAgent.dispatch('Execute', request('race-duplicate'));
await raceAgent.dispatch('Execute', request('race-duplicate'));
assert.equal(raceAgent.tasks.size, 1, 'duplicate EXECUTE reserves one identity before authorization resolves');
await raceAgent.dispatch('Cancel', request('race-duplicate'));
releaseAuthorization(true);
await firstRace;
assert.equal(starts, beforeRaceStarts, 'cancel during authorization prevents model startup');
authorize = async () => true;
await raceAgent.dispatch('Execute', request('race-duplicate'));
assert.equal(starts, beforeRaceStarts, 'cancel tombstone prevents a late duplicate from restarting');
await raceAgent.dispatch('Cancel', request('cancel-before-execute'));
await raceAgent.dispatch('Execute', request('cancel-before-execute'));
assert.equal(starts, beforeRaceStarts, 'cancel arriving before execute also prevents effects');
authorize = async () => enabled;
const storage = new Map();
const push = load('push/PushRegistrar.ets',['PushRegistrar'], {
  AppStorage:{setOrCreate:(k,v)=>storage.set(k,v)},
});
push.PushRegistrar.receive({data:JSON.stringify({session_id:'ok',machine:'mini',approval:'approve'})});
assert.equal(storage.get('pushRemoteSession'),'ok');
assert.equal(storage.has('approval'),false,'push only routes and never authorizes');
storage.clear();
push.PushRegistrar.receive({data:JSON.stringify({session_id:'../secret',machine:'mini'})});
assert.equal(storage.size,0);
push.PushRegistrar.receive({data:'invalid'});
assert.equal(storage.size,0);
const wav = load('recording/RecordingStore.ets',['wavHeader']);
for (const bytes of [0,3200,32000,32000*3600]) {
  const buf=wav.wavHeader(bytes), view=new DataView(buf);
  assert.equal(view.getUint32(4,true),bytes+36);
  assert.equal(view.getUint32(40,true),bytes);
  assert.equal(view.getUint32(24,true),16000);
  assert.equal(view.getUint32(28,true),32000);
}
assert.throws(()=>wav.wavHeader(-1));
assert.throws(()=>wav.wavHeader(3));
console.log('SYSTEM_INTEGRATION_OK A2A opt-in/duplicate/cancel/result, push routing, RIFF bounds');

// Exercise actual WAV persistence and crash recovery with SDK-style relative file offsets.
const os = await import('node:os');
const path = await import('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harmony-recording-'));
const pointers = new Map();
const io = {
  OpenMode: {READ_ONLY: fs.constants.O_RDONLY, READ_WRITE:fs.constants.O_RDWR,
    CREATE:fs.constants.O_CREAT,TRUNC:fs.constants.O_TRUNC},
  accessSync:fs.existsSync, mkdirSync:fs.mkdirSync,
  openSync(p,flags){const fd=fs.openSync(p,flags);pointers.set(fd,0);return {fd};},
  writeSync(fd,buffer,options={}){const bytes=Buffer.from(buffer);const offset=(pointers.get(fd)||0)+(options.offset||0);
    const size=fs.writeSync(fd,bytes,0,bytes.length,offset);pointers.set(fd,offset+size);return size;},
  readSync(fd,buffer,options={}){const offset=(pointers.get(fd)||0)+(options.offset||0);
    const size=fs.readSync(fd,Buffer.from(buffer),0,options.length||buffer.byteLength,offset);pointers.set(fd,offset+size);return size;},
  closeSync(file){pointers.delete(file.fd);fs.closeSync(file.fd);},fsyncSync:fs.fsyncSync,
  statSync: value=>typeof value==='number'?fs.fstatSync(value):fs.statSync(value),
  readTextSync:p=>fs.readFileSync(p,'utf8'),listFileSync:fs.readdirSync,unlinkSync:fs.unlinkSync,
};
const recordStore=load('recording/RecordingStore.ets',['RecordingStore','RecordingRecord','wavHeader'],{
  fileIo:io,util:{generateRandomUUID:()=>randomUUID()},atomicWriteText:(p,s)=>fs.writeFileSync(p,s),
});
let readCount=0, releaseRead;
let delayedCapturer = null;
let backgroundResult = async () => ({continuousTaskId:42});
const stoppedBackgroundIds = [];
const controller=load('recording/RecordingController.ets',['RecordingController'],{
  ...recordStore,fileIo:io,abilityAccessCtrl:{createAtManager:()=>({requestPermissionsFromUser:async()=>({authResults:[0]})})},
  wantAgent:{getWantAgent:async()=>({}),OperationType:{START_ABILITY:0},WantAgentFlags:{UPDATE_PRESENT_FLAG:0}},
  backgroundTaskManager:{ContinuousTaskRequest:class{},BackgroundTaskMode:{MODE_AUDIO_RECORDING:3},
    startBackgroundRunning:async()=>await backgroundResult(),stopBackgroundRunning:async(_ctx,id)=>{stoppedBackgroundIds.push(id);}},
  audio:{AudioSamplingRate:{SAMPLE_RATE_16000:16000},AudioChannel:{CHANNEL_1:1},AudioSampleFormat:{SAMPLE_FORMAT_S16LE:1},
    AudioEncodingType:{ENCODING_TYPE_RAW:0},SourceType:{SOURCE_TYPE_MIC:0},
    createAudioCapturer:async()=> delayedCapturer ? await delayedCapturer : ({start:async()=>{},release:async()=>{},
      stop:async()=>{releaseRead?.(new ArrayBuffer(0));},
      read:async()=>{if(readCount++===0)return new Uint8Array(3200).fill(7).buffer;return await new Promise(r=>releaseRead=r);}})},
});
try {
  const ctx={filesDir:directory};
  const row=await controller.RecordingController.start(ctx);
  await new Promise(resolve=>setTimeout(resolve,0));
  await controller.RecordingController.stop(ctx);
  const wavPath=recordStore.RecordingStore.path(ctx,row.id,'wav');
  const bytes=fs.readFileSync(wavPath);
  assert.equal(bytes.length,3244,'finalizing rewrites the header without appending another header');
  assert.equal(bytes.readUInt32LE(40),3200);
  assert.equal(bytes.subarray(44).every(value=>value===7),true);
  // Simulate a killed process with a stale header and a complete persisted PCM tail.
  fs.writeFileSync(wavPath,Buffer.concat([Buffer.from(recordStore.wavHeader(0)),Buffer.alloc(6400,9)]));
  row.state='recording';
  controller.RecordingController.recover(ctx,row);
  assert.equal(row.state,'interrupted');
  assert.equal(row.bytes,6400);
  assert.equal(fs.readFileSync(wavPath).readUInt32LE(40),6400);
  assert.equal(pointers.size,0,'native file handles released');
  // Stop while native create is deferred, then start a distinct recording before the old handle arrives.
  let releaseCapturer, releasedOld = 0, startedOld = 0;
  delayedCapturer = new Promise(resolve => { releaseCapturer = resolve; });
  const cancelledStart = controller.RecordingController.start(ctx);
  cancelledStart.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  await controller.RecordingController.stop(ctx);
  delayedCapturer = null;
  readCount = 0;
  const replacement = await controller.RecordingController.start(ctx);
  await new Promise(resolve => setImmediate(resolve));
  releaseCapturer({start:async()=>{startedOld++;},stop:async()=>{},release:async()=>{releasedOld++;}});
  await assert.rejects(cancelledStart);
  assert.equal(startedOld,0,'late native capturer never starts after stop');
  assert.equal(releasedOld,1,'late native capturer is released');
  assert.equal(controller.RecordingController.current.id,replacement.id,'old start cannot stop the replacement recording');
  await controller.RecordingController.stop(ctx);
  assert.equal(pointers.size,0);
  // Stop during capturer.start, and while the background lease is deferred.
  let releaseNativeStart, lateStartReleased=0;
  delayedCapturer=Promise.resolve({start:async()=>await new Promise(resolve=>releaseNativeStart=resolve),
    stop:async()=>{},release:async()=>{lateStartReleased++;}});
  const nativeStart=controller.RecordingController.start(ctx); nativeStart.catch(()=>{});
  await new Promise(resolve=>setImmediate(resolve));
  await controller.RecordingController.stop(ctx);
  releaseNativeStart();
  await assert.rejects(nativeStart);
  assert.ok(lateStartReleased>=1,'a stopped native start releases its own resource');
  delayedCapturer=null;
  let releaseBackground;
  backgroundResult=async()=>await new Promise(resolve=>releaseBackground=resolve);
  const leaseStart=controller.RecordingController.start(ctx);leaseStart.catch(()=>{});
  await new Promise(resolve=>setImmediate(resolve));
  await controller.RecordingController.stop(ctx);
  backgroundResult=async()=>({continuousTaskId:99});readCount=0;
  const leaseReplacement=await controller.RecordingController.start(ctx);
  await new Promise(resolve=>setImmediate(resolve));
  releaseBackground({continuousTaskId:77});
  await assert.rejects(leaseStart);
  assert.ok(stoppedBackgroundIds.includes(77),'late lease is cancelled by its exact task id');
  assert.equal(stoppedBackgroundIds.includes(99),false,'late completion cannot cancel replacement lease');
  assert.equal(controller.RecordingController.current.id,leaseReplacement.id);
  await controller.RecordingController.stop(ctx);
  assert.ok(stoppedBackgroundIds.includes(99));

  // Production transcription reads three successive PCM segments using the SDK relative-offset contract.
  const transcriptRow=recordStore.RecordingStore.create(ctx);
  const chunkSize=16000*2*28;
  const chunks=[Buffer.alloc(chunkSize,1),Buffer.alloc(chunkSize,2),Buffer.alloc(3200,3)];
  transcriptRow.bytes=chunkSize*2+3200;
  fs.writeFileSync(recordStore.RecordingStore.path(ctx,transcriptRow.id,'wav'),
    Buffer.concat([Buffer.from(recordStore.wavHeader(transcriptRow.bytes)),...chunks]));
  const transcript=load('recording/RecordingTranscriber.ets',['RecordingTranscriber'],{...recordStore,fileIo:io});
  const seen=[];
  transcript.RecordingTranscriber.recognize=async buffer=>{seen.push(new Uint8Array(buffer)[0]);return 'segment-'+seen.at(-1);};
  await transcript.RecordingTranscriber.transcribe(ctx,transcriptRow);
  assert.deepEqual(seen,[1,2,3]);
  assert.equal(transcriptRow.transcript,'segment-1\nsegment-2\nsegment-3');
  assert.equal(pointers.size,0);
  console.log('RECORDING_PERSISTENCE_OK actual capture/write/finalize/recover with relative native offsets');
} finally {
  fs.rmSync(directory,{recursive:true,force:true});
}
