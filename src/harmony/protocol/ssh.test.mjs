// Actual ArkTS SSH controller boundaries with native/DNS/credential adapters.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
const root=new URL('../app/entry/src/main/ets/',import.meta.url);
function load(file,names,environment={}) {
 const source=fs.readFileSync(new URL(file,root),'utf8').replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm,'').replace(/\bexport /g,'');
 const context=vm.createContext({console,setTimeout,clearTimeout,...environment});
 vm.runInContext(stripTypeScriptTypes(source,{mode:'strip'})+'\nObject.assign(globalThis,{'+names.join(',')+'});',context);
 return Object.fromEntries(names.map(name=>[name,context[name]]));
}
const util={generateRandomUUID:()=>crypto.randomUUID(),TextEncoder:class{encodeInto(value){return new TextEncoder().encode(value);}},
 TextDecoder:{create:()=>{const decoder=new TextDecoder();return {decodeToString:(bytes,options)=>decoder.decode(bytes,options)};}}};
const definitions=load('ssh/SSHHostStore.ets',['validateSSHHost','SSHHost','SSHCredential']);
const host=new definitions.SSHHost();Object.assign(host,{id:'host-a',host:'server.example',username:'user',hostKey:'ssh-ed25519 '+Buffer.alloc(40,1).toString('base64')});
definitions.validateSSHHost(host);
assert.throws(()=>definitions.validateSSHHost({...host,host:'bad;touch injected'}));
assert.throws(()=>definitions.validateSSHHost({...host,hostKey:'SHA256:unverified-fingerprint'}));
let dnsResolve,credentialResolve,started=0,stopped=0;
let nativeFrames=[];
let dns=async()=>[{address:'127.0.0.1',family:1}],credential=async()=>({privateKey:'PRIVATE',passphrase:'PASS',password:''});
const nativeCalls=[];
const native={start(options){started++;nativeCalls.push({...options});return started;},stop(){stopped++;},write(_id,_owner,text){return new TextEncoder().encode(text).length;},resize(){},
 poll(){if(nativeFrames.length)return nativeFrames.shift();return {buffer:new ArrayBuffer(0),state:'connected',error:'',fingerprint:'SHA256:fixture',exitCode:0,truncated:false};}};
const runtime=load('local/SSHRuntime.ets',['SSHRuntime'],{...definitions,util,connection:{getAddressesByName:async()=>await dns()},
 SSHHostStore:{credential:async()=>await credential()},nativeSSH:native});
dns=async()=>await new Promise(resolve=>dnsResolve=resolve);
const first=runtime.SSHRuntime.start('window-a',host);runtime.SSHRuntime.stop('window-a');dnsResolve([{address:'127.0.0.1',family:1}]);
await assert.rejects(first,/取消/);assert.equal(started,0,'cancel before DNS returns cannot start native authentication');
dns=async()=>[{address:'127.0.0.1',family:1}];credential=async()=>await new Promise(resolve=>credentialResolve=resolve);
const second=runtime.SSHRuntime.start('window-a',host);await new Promise(resolve=>setImmediate(resolve));
runtime.SSHRuntime.stopAll();credentialResolve({privateKey:'LATE',passphrase:'',password:''});
await assert.rejects(second,/取消/);assert.equal(started,0,'background stopAll also invalidates pending credential reads');
credential=async()=>({privateKey:'PRIVATE',passphrase:'PASS',password:''});
await runtime.SSHRuntime.start('window-a',host);assert.equal(started,1);assert.equal(nativeCalls[0].privateKey,'PRIVATE');
runtime.SSHRuntime.write('window-a','\u0000');
const unicode=new TextEncoder().encode('布布');
nativeFrames=[{buffer:unicode.slice(0,2).buffer,state:'connected',error:'',fingerprint:'',exitCode:0,truncated:false},{buffer:unicode.slice(2).buffer,state:'connected',error:'',fingerprint:'',exitCode:0,truncated:false}];
assert.equal(runtime.SSHRuntime.poll('window-a').text,'');
assert.equal(runtime.SSHRuntime.poll('window-a').text,'布布','native byte fragments retain one streaming decoder per SSH connection');
assert.throws(()=>runtime.SSHRuntime.write('other-window','hello'),/没有连接/);
assert.throws(()=>runtime.SSHRuntime.write('window-a','a'.repeat(4097)),/4096/);
runtime.SSHRuntime.stopAll();assert.equal(stopped,1);
console.log('SSH_RUNTIME_OK actual DNS/credential cancellation interleavings, background pending-start cancellation, owner isolation, NUL input and byte limits');
