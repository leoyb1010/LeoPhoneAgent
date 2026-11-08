import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
const source=fs.readFileSync(new URL('../app/entry/src/main/ets/local/Voice.ets',import.meta.url),'utf8').replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm,'').replace(/\bexport\s+/g,'');
const engines=[];const capturers=[];let releasePermission;let deferCapture=false;let createPending;
function capture(){const cap={started:0,stopped:0,released:0,readResolve:null,start:async()=>{cap.started++;},stop:async()=>{cap.stopped++;},release:async()=>{cap.released++;},read:()=>new Promise(resolve=>{cap.readResolve=resolve;})};capturers.push(cap);return cap;}
const context=vm.createContext({console,Uint8Array,ArrayBuffer,
 abilityAccessCtrl:{createAtManager:()=>({requestPermissionsFromUser:()=>new Promise(resolve=>{releasePermission=resolve;})})},
 audio:{AudioSamplingRate:{SAMPLE_RATE_16000:16000},AudioChannel:{CHANNEL_1:1},AudioSampleFormat:{SAMPLE_FORMAT_S16LE:1},AudioEncodingType:{ENCODING_TYPE_RAW:1},SourceType:{SOURCE_TYPE_MIC:1},
 createAudioCapturer:async()=>{if(deferCapture)return await new Promise(resolve=>{createPending=resolve;});return capture();}},
 speechRecognizer:{createEngine:async()=>{const engine={listener:null,writes:0,finished:0,closed:0,setListener(listener){engine.listener=listener;},startListening(){},finish(){engine.finished++;},shutdown(){engine.closed++;},writeAudio(){engine.writes++;}};engines.push(engine);return engine;}}});
vm.runInContext(stripTypeScriptTypes(source,{mode:'strip'})+'\nglobalThis.Voice=Voice;',context);const {Voice}=context;
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
let current=true;const cancelled=Voice.listen({},()=>{},()=>{},()=>current);current=false;releasePermission({authResults:[0]});await assert.rejects(cancelled,/取消/);await flush();assert.equal(engines.length,0);assert.equal(capturers.length,0);
const text=[];const first=Voice.listen({},(value,last)=>text.push([value,last]),()=>{});await flush();releasePermission({authResults:[0]});const stopFirst=await first;const oldEngine=engines[0],oldCapture=capturers[0];
oldEngine.listener.onResult('leo',{result:'recognized',isLast:true,isFinal:true});await flush();assert.deepEqual(text,[['recognized',true]]);assert.equal(oldCapture.released,1);assert.equal(oldEngine.closed,1,'natural final closes recognizer and microphone');
const second=Voice.listen({},value=>text.push([value]),()=>{});await flush();releasePermission({authResults:[0]});const stopSecond=await second;
oldCapture.readResolve(new ArrayBuffer(32));oldEngine.listener.onResult('leo',{result:'stale',isLast:false,isFinal:false});await flush();assert.equal(oldEngine.writes,0);assert.equal(engines[1].writes,0);assert.equal(text.length,1,'late old engine/audio callbacks cannot write into the next recording');
await assert.rejects(Voice.listen({},()=>{},()=>{}),/另一个会话/);stopSecond();await flush();assert.equal(capturers[1].released,1);
deferCapture=true;let errors=0;const duringCreate=Voice.listen({},()=>{},()=>errors++).catch(error=>error);await flush();releasePermission({authResults:[0]});await flush();assert.ok(createPending);engines[2].listener.onError('leo',1,'service stopped');const late=capture();createPending(late);const failed=await duringCreate;assert.match(failed.message,/取消/);await flush();assert.equal(late.released,1,'a capturer resolving after close is still released');assert.equal(late.started,0);assert.equal(errors,1);
stopFirst();stopSecond();assert.equal(oldCapture.released,1,'close is idempotent');
console.log('HARMONY_VOICE_LIFECYCLE_OK production ETS permission cancellation, final cleanup, owner exclusion, stale callback isolation and late-created microphone release');
