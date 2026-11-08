// Execute production ETS decisions and the fixed script's real filesystem rejection paths.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {spawnSync} from 'node:child_process';
const source=fs.readFileSync(new URL('../app/entry/src/main/ets/local/LinuxRuntime.ets',import.meta.url),'utf8')
 .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm,'').replace(/\bexport /g,'');
function runtime({addresses=['192.0.2.53','2001:db8::53'],sdkError=null,exitCode=0,pollError=false}={}) {
 const calls=[],logs=[];
 const scope=vm.createContext({console:{info:s=>logs.push(s)},setTimeout,clearTimeout,Uint8Array,ArrayBuffer,
  connection:{getDefaultNet:async()=>({}),getConnectionProperties:async()=>{if(sdkError)throw sdkError;return{dnses:addresses.map(address=>({address}))};}},
  fileIo:{openSync(){assert.fail('DNS must not bypass guest metadata by opening the host backing file');}},
  util:{TextDecoder:{create:()=>{const decoder=new TextDecoder();return{decodeToString:bytes=>decoder.decode(bytes)};}}},
  nativeLinux:{start(command,interactive){calls.push(['start',command,interactive]);return 31;},
   poll(){if(pollError)throw Error('poll fixture');return{buffer:new TextEncoder().encode(exitCode===0?'LEO_GUEST_DNS_WRITE_OK':'').buffer,exited:true,exitCode,truncated:false};},
   stop(pid){calls.push(['stop',pid]);}}
 });
 vm.runInContext(stripTypeScriptTypes(source,{mode:'strip'})+'\nObject.assign(globalThis,{LinuxRuntime,guestDNSWriteScript});',scope);
 return{...scope,calls,logs};
}
const success=runtime();assert.equal(success.LinuxRuntime.ready,false);
await success.LinuxRuntime.refreshDNS();assert.equal(success.LinuxRuntime.dnsStatus.phase,'ready');assert.equal(success.LinuxRuntime.dnsStatus.serverCount,2);
assert.equal(success.calls[0][0],'start');assert.equal(success.calls[0][2],false,'raw native execution works before ready');
const script=success.calls[0][1];assert.ok(script.includes("printf '%s\\n'"));assert.ok(script.includes('mv -T --'));assert.ok(script.includes('[ ! -L /etc/resolv.conf ]'));
assert.equal(success.logs.join('').includes('192.0.2.53'),false);assert.equal(success.logs.join('').includes('2001:db8::53'),false);
for(const bad of [[],['1.1.1.1;touch /tmp/x'],['1.1.1.1\nsearch injected'],['$HOME'],['1.1.1.1','2.2.2.2','3.3.3.3','4.4.4.4']])assert.throws(()=>success.guestDNSWriteScript(bad));
const noDns=runtime({addresses:[]});await noDns.LinuxRuntime.refreshDNS();assert.equal(noDns.calls.length,0);assert.equal(noDns.LinuxRuntime.dnsStatus.phase,'no_dns');
const unavailable=runtime({sdkError:{code:2100002}});await unavailable.LinuxRuntime.refreshDNS();assert.equal(unavailable.calls.length,0);assert.equal(unavailable.LinuxRuntime.dnsStatus.errorCode,2100002);
const refused=runtime({exitCode:73});await refused.LinuxRuntime.refreshDNS();assert.equal(refused.LinuxRuntime.dnsStatus.exitCode,73);assert.notEqual(refused.LinuxRuntime.networkStatus,success.LinuxRuntime.networkStatus);
const interrupted=runtime({pollError:true});await interrupted.LinuxRuntime.refreshDNS();assert.deepEqual(interrupted.calls.at(-1),['stop',31]);
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'leobot-dns-guard-'));
try{
 const directory=path.join(temporary,'etc');fs.mkdirSync(directory);const victim=path.join(temporary,'victim');fs.writeFileSync(victim,'DO_NOT_REPLACE');
 fs.symlinkSync(victim,path.join(directory,'resolv.conf'));
 const rejection=spawnSync('/bin/sh',['-c',script.replaceAll('/etc',directory)],{encoding:'utf8'});
 assert.equal(rejection.status,73);assert.equal(fs.readFileSync(victim,'utf8'),'DO_NOT_REPLACE');assert.equal(fs.lstatSync(path.join(directory,'resolv.conf')).isSymbolicLink(),true);
 fs.unlinkSync(path.join(directory,'resolv.conf'));fs.mkdirSync(path.join(directory,'resolv.conf'));
 assert.equal(spawnSync('/bin/sh',['-c',script.replaceAll('/etc',directory)],{encoding:'utf8'}).status,74);
 console.log('LINUX_DNS_ACTUAL_ETS_OK SDK phase/errors, no host-file bypass, pre-ready native guest write, failure cleanup, no DNS-address logging, real symlink/non-file rejection');
}finally{fs.rmSync(temporary,{recursive:true,force:true});}
