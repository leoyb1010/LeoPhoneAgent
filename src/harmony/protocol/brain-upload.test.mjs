import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {randomUUID,createHash} from 'node:crypto';
const root=new URL('../app/entry/src/main/ets/brain/',import.meta.url);
const read=name=>fs.readFileSync(new URL(name,root),'utf8').replace(/^import[^\n]*\n/gm,'').replace(/\bexport\s+/g,'');
const bytes=Buffer.from('abcdefghi'), seeks=[],chunks=[],requests=[];
let secret='',pauseHash=false,hashReady,continueHash;
const fds=new Map();let nextFd=0;
const fileIo={
  OpenMode:{READ_ONLY:1,NOFOLLOW:2},WhenceType:{SEEK_SET:0},accessSync:()=>true,
  openSync(){const fd=++nextFd;fds.set(fd,{position:0});return{fd};},closeSync(file){fds.delete(file.fd);},
  lseek(fd,offset){seeks.push(offset);fds.get(fd).position=offset;},
  readSync(fd,target,options){const state=fds.get(fd);if(options?.offset)state.position+=options.offset;
    const n=Math.min(target.byteLength,bytes.length-state.position);new Uint8Array(target).set(bytes.subarray(state.position,state.position+n));state.position+=n;return n;},
};
const http={RequestMethod:{GET:'GET',POST:'POST'},HttpDataType:{STRING:0,ARRAY_BUFFER:1},createHttp(){return{destroy(){},async request(url,options){
  requests.push({url,options});
  if(url.endsWith('/session'))return{responseCode:200,result:'{"token":"page"}'};
  if(url.endsWith('/upload/up'))return{responseCode:200,result:'{"received":0,"chunk":3}'};
  if(url.includes('/upload/up?offset=')){
    const data=Buffer.from(options.extraData);chunks.push(data);
    assert.equal(options.header['X-Chunk-SHA256'],createHash('sha256').update(data).digest('hex'));
    return{responseCode:200,result:JSON.stringify({received:Number(url.split('offset=')[1])+data.length})};
  }
  if(url.endsWith('/finish'))return{responseCode:200,result:'{"file_id":"file-one"}'};
  if(url.includes('/pipeline?'))return{responseCode:200,result:'{"items":[{"stages":[{"state":"completed"}]}]}'};
  throw Error('unexpected '+url);
}};}};
const context=vm.createContext({console,Date,setTimeout,ArrayBuffer,Uint8Array,fileIo,http,
  SecretStore:{read:async()=>secret,write:async(_key,value)=>secret=value},util:{generateRandomUUID:()=>randomUUID()},
  AtomicTextFile:class{read(){return '';}write(){}},
  cryptoFramework:{createMd(){let value;return{async update(blob){value=Buffer.from(blob.data);},async digest(){
    if(pauseHash){hashReady();await new Promise(resolve=>continueHash=resolve);}
    return{data:new Uint8Array(createHash('sha256').update(value).digest())};
  }};}},
});
vm.runInContext(stripTypeScriptTypes(read('BrainAPI.ets')+'\n'+read('BrainUpload.ets'),{mode:'strip'})+'\nglobalThis.API=BrainAPI;globalThis.Upload=BrainUpload;globalThis.Job=BrainUploadJob;',context);
const api=context.API;
async function setup(){await api.connect('https://a.example','a'.repeat(32),'','');api.unlockedUntil=Date.now()+60000;
  const upload=new context.Upload();upload.load({filesDir:'/files'});const job=new context.Job();job.id='job-one';job.uploadId='up';job.name='sample';job.size=9;job.generation=api.generation();upload.jobs=[job];return{upload,job};}
let {upload,job}=await setup();await upload.run(job,()=>{});
assert.deepEqual(seeks,[0,3,6]);assert.deepEqual(chunks.map(buffer=>buffer.toString()),['abc','def','ghi']);assert.equal(job.stage,'内容理解完成');
for(const action of ['switch','lock']){
  ({upload,job}=await setup());pauseHash=true;
  const ready=new Promise(resolve=>hashReady=resolve);
  const running=upload.run(job,()=>{});await ready;const count=requests.length;
  if(action==='switch')await api.connect('https://b.example','b'.repeat(32),'','');else api.invalidate();
  api.unlockedUntil=Date.now()+60000;
  pauseHash=false;continueHash();await assert.rejects(running,/改变/);
  assert.equal(requests.length,count,'No network sends after hash lease invalidation');
}
console.log('BRAIN_UPLOAD_OK actual ETS three-part absolute IO, SHA256, hash-await connection/lock cancellation');
