import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
const source=fs.readFileSync(new URL('../app/entry/src/main/ets/sync/ReplicaAssets.ets',import.meta.url),'utf8').replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm,'').replace(/\bexport\s+/g,'');
const positions=new Map();const io={OpenMode:{READ_ONLY:fs.constants.O_RDONLY,READ_WRITE:fs.constants.O_RDWR,CREATE:fs.constants.O_CREAT,NOFOLLOW:fs.constants.O_NOFOLLOW},WhenceType:{SEEK_SET:0},
 lstatSync:fs.lstatSync,accessSync:fs.existsSync,mkdirSync:fs.mkdirSync,renameSync:fs.renameSync,unlinkSync:fs.unlinkSync,
 openSync:(p,f)=>{const fd=fs.openSync(p,f);positions.set(fd,0);return{fd};},closeSync:f=>{positions.delete(f.fd);fs.closeSync(f.fd);},fsyncSync:fs.fsyncSync,
 lseek:(fd,offset)=>{positions.set(fd,offset);return offset;},
 readSync:(fd,buffer)=>{const n=fs.readSync(fd,Buffer.from(buffer),0,buffer.byteLength,positions.get(fd));positions.set(fd,positions.get(fd)+n);return n;},
 writeSync:(fd,buffer)=>{const n=fs.writeSync(fd,Buffer.from(buffer),0,buffer.byteLength,positions.get(fd));positions.set(fd,positions.get(fd)+n);return n;}};
const remote=new Map();const requests=[];let failSecond=true;const counts=new Map();
const array=b=>b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);
const response=(responseCode,header,bytes=Buffer.alloc(0))=>({responseCode,header,result:array(bytes)});
const http={HttpDataType:{ARRAY_BUFFER:1},createHttp:()=>({destroy(){},request:async(url,options)=>{requests.push({url,options});const hash=url.split('/').at(-1);let item=remote.get(hash);
 if(options.method==='HEAD')return item?response(200,{'Upload-Offset':String(item.bytes.length),'Upload-Length':String(item.total),'X-Asset-Complete':String(item.bytes.length===item.total)}):response(404,{});
 if(options.method==='PUT'){
  const m=/bytes (\d+)-(\d+)\/(\d+)/.exec(options.header['Content-Range']);const start=Number(m[1]);const total=Number(m[3]);
  const count=(counts.get(hash)||0)+1;counts.set(hash,count);if(count===2&&failSecond){failSecond=false;throw new Error('simulated disconnect');}
  const chunk=Buffer.from(options.extraData);if(!item||options.header['Upload-Reset']==='true'){item={bytes:Buffer.alloc(0),total};remote.set(hash,item);}
  assert.equal(start,item.bytes.length);item.bytes=Buffer.concat([item.bytes,chunk]);return response(200,{},Buffer.from(JSON.stringify({offset:item.bytes.length,complete:item.bytes.length===total})));
 }
 const m=/bytes=(\d+)-(\d+)/.exec(options.header.Range);const start=Number(m[1]),end=Number(m[2]);return response(206,{'Content-Range':`bytes ${start}-${end}/${item.total}`},item.bytes.subarray(start,end+1));
}})};
const context=vm.createContext({console,Uint8Array,ArrayBuffer,fileIo:io,http,normalizeReplicaRoot:x=>x,
 util:{TextEncoder:class{encodeInto(s){return new TextEncoder().encode(s);}},TextDecoder:class{decodeWithStream(bytes){return new TextDecoder().decode(bytes);}}},
 cryptoFramework:{createMd:()=>{const hash=createHash('sha256');return{update:async b=>{hash.update(b.data);},digest:async()=>({data:new Uint8Array(hash.digest())})};}}});
vm.runInContext(stripTypeScriptTypes(source,{mode:'strip'})+'\nglobalThis.ReplicaAssets=ReplicaAssets;',context);
const {ReplicaAssets}=context;const temp=fs.mkdtempSync(path.join(os.tmpdir(),'harmony-assets-'));const ctx={filesDir:temp};
try{
 const original=Buffer.alloc(2*1024*1024+317);for(let i=0;i<original.length;i++)original[i]=(i*17+11)%251;
 const file=path.join(temp,'source.bin');fs.writeFileSync(file,original);const hash=createHash('sha256').update(original).digest('hex');
 const client=new ReplicaAssets(ctx,'https://replica.test','paired','grant');
 await assert.rejects(client.upload(file,'asset','application/octet-stream'),/disconnect/);assert.equal(remote.get(hash).bytes.length,1024*1024);
 const uploaded=await client.upload(file,'asset','application/octet-stream');assert.equal(uploaded.sha256,hash);assert.equal(uploaded.size,original.length);assert.deepEqual(remote.get(hash).bytes,original,'second and third slices use absolute file offsets after resume');
 fs.mkdirSync(path.join(temp,'sync-assets'));fs.writeFileSync(path.join(temp,'sync-assets',hash+'.partial'),original.subarray(0,1024*1024));
 const downloaded=await client.download(uploaded);assert.deepEqual(fs.readFileSync(downloaded),original);assert.equal(fs.existsSync(downloaded+'.partial'),false);
 const get=requests.find(req=>req.options.method==='GET');assert.equal(get.options.header.Range,`bytes=1048576-${2*1024*1024-1}`);
 fs.symlinkSync(file,path.join(temp,'alias'));await assert.rejects(client.upload(path.join(temp,'alias'),'asset','text/plain'),/符号链接/);
 await assert.rejects(client.upload('/etc/hosts','asset','text/plain'),/应用文件目录/);
 for(const req of requests){assert.equal(req.options.maxRedirects,0);assert.equal(req.options.header.Authorization,'Bearer grant');assert.equal(req.options.header['X-Leo-Device-ID'],'paired');}
 console.log('HARMONY_REPLICA_ASSETS_OK production ETS three-chunk resume, absolute offsets, HEAD/PUT/Range receipts, SHA256 roundtrip, origin and path boundaries');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
