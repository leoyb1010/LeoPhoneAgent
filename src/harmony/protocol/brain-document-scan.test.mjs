import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
const source=fs.readFileSync(new URL('../app/entry/src/main/ets/local/DocumentScanFlow.ets',import.meta.url),'utf8')
  .replace(/^import[^\n]*\n/gm,'').replace(/\bexport\s+/g,'');
let foreground=true,current=true,chosenId='',sequence=0,readWait,destinationFailure=false;
const deleted=[],closed=[],written=[];
const fileIo={
  OpenMode:{READ_ONLY:1,READ_WRITE:2,CREATE:4,TRUNC:8,NOFOLLOW:16},accessSync:()=>true,
  openSync(path){if(path.startsWith('source://'))return{fd:1};if(destinationFailure)throw Error('disk unavailable');return{fd:2};},
  closeSync(file){closed.push(file.fd);},statSync:()=>({size:3}),
  async read(_fd,buffer){if(readWait)await readWait;new Uint8Array(buffer).set([1,2,3]);return 3;},
  async write(_fd,_buffer,options){written.push(options.length);return options.length;},
  fsync:async()=>{},unlinkSync:path=>deleted.push(path),
};
const context=vm.createContext({console,ArrayBuffer,Uint8Array,fileIo,AppStorage:{get:()=>foreground},
  setTimeout:()=>1,clearTimeout(){},util:{generateRandomUUID:()=>String(++sequence)},
  AppNavigation:{pushUrl:async options=>{chosenId=options.params.scanId;}}});
vm.runInContext(stripTypeScriptTypes(source,{mode:'strip'})+'\nglobalThis.Scan=DocumentScanFlow;',context);
const flow=context.Scan,app={filesDir:'/app/files'};
await assert.rejects(flow.open(app,()=>false),/取消/);
assert.equal(chosenId,'');
let promise=flow.open(app,()=>current);let expected=assert.rejects(promise,/取消/);
current=false;await flow.finish(app,chosenId,['source://original'],'.pdf');await expected;
assert.equal(written.length,0);
current=true;promise=flow.open(app,()=>current);
let releaseRead;readWait=new Promise(resolve=>releaseRead=resolve);
expected=assert.rejects(promise,/取消/);
const copying=flow.finish(app,chosenId,['source://original'],'.pdf');
await new Promise(resolve=>setImmediate(resolve));current=false;releaseRead();await copying;await expected;
assert.equal(written.length,0);
assert.ok(deleted.some(path=>path.startsWith('/app/files/workspace/scan-')));
assert.ok(!deleted.some(path=>path.startsWith('source://')));
assert.ok(closed.includes(1)&&closed.includes(2));
current=true;readWait=undefined;destinationFailure=true;promise=flow.open(app,()=>current);
expected=assert.rejects(promise,/disk unavailable/);
const closedBefore=closed.length;await flow.finish(app,chosenId,['source://original'],'.pdf');await expected;
assert.ok(closed.slice(closedBefore).includes(1));
destinationFailure=false;promise=flow.open(app,()=>current);
await flow.finish(app,chosenId,['source://original'],'.jpg');
const result=JSON.parse(await promise);assert.equal(result.status,'scanned');assert.equal(result.paths.length,1);assert.deepEqual(written,[3]);
console.log('DOCUMENT_SCAN_OK actual ETS cancellation before routing/during read, owned output cleanup, source FD closure and successful save');

current=true;foreground=true;promise=flow.open(app,()=>current);foreground=false;
await flow.finish(app,chosenId,['source://original'],'.jpg');
assert.equal(JSON.parse(await promise).status,'scanned');
console.log('DOCUMENT_SCAN_UI_RESULT_OK issued user selection survives parent foreground transition');
