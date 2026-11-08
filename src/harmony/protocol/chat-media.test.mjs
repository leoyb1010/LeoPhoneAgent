// Executes the production ETS parser, request builder, media persistence, ChatRun and SessionStore.
// Native ImageKit/HTTP/FileIO have explicit platform adapters. SDK/device rendering is separate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createHash,randomUUID} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
const root=new URL('../app/entry/src/main/ets/',import.meta.url);
function load(file,env={}){
 const raw=fs.readFileSync(new URL(file,root),'utf8');const names=[...raw.matchAll(/^export (?:class|function|const) (\w+)/gm)].map(m=>m[1]);
 const source=raw.replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm,'').replace(/\bexport\s+/g,'');
 const c=vm.createContext({WearTools:{cancelOwner(){}},console,ArrayBuffer,Uint8Array,setTimeout,clearTimeout,setInterval,clearInterval,...env});
 vm.runInContext(stripTypeScriptTypes(source,{mode:'strip'})+`\nObject.assign(globalThis,{${names.join(',')}});`,c,{filename:file});
 return Object.fromEntries(names.map(name=>[name,c[name]]));
}
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNg2DzrPwAEUQJNXSumLgAAAABJRU5ErkJggg==','base64');
const array=bytes=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length);
const util={generateRandomUUID:()=>randomUUID(),TextEncoder:class{encodeInto(s){return new TextEncoder().encode(s);}},TextDecoder:{create:()=>({decodeToString:(bytes)=>new TextDecoder().decode(bytes)})},Base64Helper:class{encodeToStringSync(b){return Buffer.from(b).toString('base64');}decodeSync(s){return new Uint8Array(Buffer.from(s,'base64'));}}};
let shortRead=false;
const io={OpenMode:{READ_ONLY:fs.constants.O_RDONLY,READ_WRITE:fs.constants.O_RDWR,CREATE:fs.constants.O_CREAT,TRUNC:fs.constants.O_TRUNC,NOFOLLOW:fs.constants.O_NOFOLLOW,DIR:fs.constants.O_DIRECTORY},
 accessSync:fs.existsSync,lstatSync:fs.lstatSync,statSync:p=>typeof p==='number'?fs.fstatSync(p):fs.statSync(p),mkdirSync:(p)=>fs.mkdirSync(p),listFileSync:p=>fs.readdirSync(p),readTextSync:p=>fs.readFileSync(p,'utf8'),
 openSync:(p,flags)=>({fd:fs.openSync(p,flags)}),closeSync:f=>fs.closeSync(f.fd),close:async f=>fs.closeSync(f.fd),
 readSync:(fd,buffer)=>shortRead?0:fs.readSync(fd,Buffer.from(buffer)),writeSync:(fd,buffer)=>fs.writeSync(fd,typeof buffer==='string'?buffer:Buffer.from(buffer)),
 write:async(fd,buffer)=>fs.writeSync(fd,Buffer.from(buffer)),fsyncSync:fs.fsyncSync,fsync:async fd=>fs.fsyncSync(fd),renameSync:fs.renameSync,unlinkSync:fs.unlinkSync};
const cryptoFramework={createMd:()=>{const hash=createHash('sha256');return{update:async({data})=>{hash.update(data);},digest:async()=>({data:new Uint8Array(hash.digest())})};}};
let dimensions={width:1,height:1};let decodeWait=null;
const image={createImageSource:()=>({getImageInfo:async()=>{if(decodeWait)await decodeWait;return{size:dimensions};},createPixelMap:async()=>({release:async()=>{}}),release:async()=>{}})};
const network=[];let responseCode=200,downloadGate=null;
const imageHttp={RequestMethod:{GET:'GET'},HttpDataType:{ARRAY_BUFFER:1},createHttp:()=>({destroy(){},request:async(url,options)=>{network.push({url,options});if(downloadGate)await downloadGate;return{responseCode,result:array(png)};}})};
const media=load('local/GeneratedMedia.ets',{fileIo:io,util,cryptoFramework,image,http:imageHttp,deviceInfo:{sdkApiVersion:26},url:{URL}});
const protocol=load('local/LocalProtocol.ets',{util,...load('local/ExtraToolSchemas.ets'),...load('local/MailTools.ets')});const models=load('local/ProviderModels.ets');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'harmony-chat-media-'));const context={filesDir:temp};
try{
 const fixtures=[
  {candidates:[{content:{role:'model',parts:[{inlineData:{mimeType:'image/png',data:png.toString('base64')}}]}}]},
  {type:'response.output_item.done',item:{type:'image_generation_call',id:'ig_1',status:'completed',result:png.toString('base64'),output_format:'png'}},
  {choices:[{delta:{images:[{image_url:{url:'data:image/png;base64,'+png.toString('base64')}}]}}]},
  {data:[{b64_json:png.toString('base64')}]}
 ];
 for(const fixture of fixtures)assert.equal(media.GeneratedMedia.parseEvent(JSON.stringify(fixture)).length,1);
 const partial=media.GeneratedMedia.parseEvent(JSON.stringify({type:'response.image_generation_call.partial_image',partial_image_b64:png.toString('base64'),item_id:'ig_1'}))[0];assert.equal(partial.final,false);
 await assert.rejects(media.GeneratedMedia.save(context,partial,()=>true),/等待完整/);
 const candidate=media.GeneratedMedia.parseEvent(JSON.stringify(fixtures[0]))[0];
 const saved=await media.GeneratedMedia.save(context,candidate,()=>true);assert.deepEqual(fs.readFileSync(saved.path),png);assert.equal(saved.contentHash,createHash('sha256').update(png).digest('hex'));
 const remote=media.GeneratedMedia.parseEvent(JSON.stringify({data:[{url:'https://preview.test/image?signature=PRIVATE_SIGNED_TOKEN'}]}))[0];await media.GeneratedMedia.save(context,remote,()=>true);
 assert.equal(network.at(-1).options.maxRedirects,0);assert.deepEqual(Object.keys(network.at(-1).options.header),['Accept']);
 responseCode=302;await assert.rejects(media.GeneratedMedia.save(context,remote,()=>true),error=>!error.message.includes('PRIVATE_SIGNED_TOKEN'));responseCode=200;
 assert.throws(()=>media.GeneratedMedia.parseEvent(JSON.stringify({data:[{url:'http://unsafe.test/image'}]})),/HTTPS/);
 const initialFiles=fs.readdirSync(path.join(temp,'chat-images')).length;let release;decodeWait=new Promise(r=>release=r);let current=true;
 const cancelled=media.GeneratedMedia.save(context,candidate,()=>current);await Promise.resolve();current=false;release();await assert.rejects(cancelled,/取消/);decodeWait=null;
 assert.equal(fs.readdirSync(path.join(temp,'chat-images')).length,initialFiles,'cancelled decode never publishes a file');
 dimensions={width:100000,height:100000};await assert.rejects(media.GeneratedMedia.save(context,candidate,()=>true),/像素/);dimensions={width:1,height:1};
 const a=new protocol.ChatImage();Object.assign(a,{b64:png.toString('base64'),mime:'image/png',path:saved.path});const b=new protocol.ChatImage();Object.assign(b,{b64:Buffer.from('second').toString('base64'),mime:'image/jpeg',path:saved.path});
 const input=new protocol.LoopTurn();input.content='compare';input.images=[a,b];
 for(const [name,field] of [['wireMessagesJson','content'],['anthropicMessagesJson','content'],['geminiContentsJson','parts'],['responsesInputJson','content']]){
  const body=JSON.parse(protocol[name]([input],''));assert.equal(body[0][field].length,3,name+' serializes both images');
 }
 assert.equal(protocol.trimHistory([input],60000)[0].images.length,2,'all current-turn input images survive history trimming');
 const legacy=protocol.sessionArchiveFromJson({messages:[{role:'user',text:'old',imageB64:a.b64,imageMime:a.mime}]});assert.equal(legacy.messages[0].images.length,1);
 assert.equal(models.modelImageMode('custom',JSON.stringify({modalityOverride:65}),'openAI'),'images');
 assert.equal(models.modelImageMode('custom',JSON.stringify({modalities:{output:['text','image']}}),'gemini'),'multimodal');
 const requests=[];let imageAttempts=0;
 const http={RequestMethod:{POST:'POST'},HttpDataType:{ARRAY_BUFFER:1},createHttp:()=>{const handlers={};return{on:(name,callback)=>{handlers[name]=callback;},destroy(){},handlers,request:async(url,options)=>{
  requests.push({url,options});imageAttempts++;if(imageAttempts===1)return{responseCode:400,result:array(Buffer.from('{"error":{"message":"response_format unsupported"}}'))};return{responseCode:200,result:array(Buffer.from(JSON.stringify(fixtures[3])))};
 },requestInStream:(url,options)=>{requests.push({url,options});return Promise.resolve(200);}};}};
 const {OpenAICompatClient}=load('local/OpenAICompatClient.ets',{...protocol,...models,...media,http,util});
 const client=new OpenAICompatClient('https://provider.test/v1','PRIVATE_PROVIDER_KEY','gpt-image-2','openAI','apiKey','','session');
 const imageResult=await new Promise((resolve,reject)=>client.streamTurn([input],'','',()=>{},resolve,reject));assert.equal(imageResult.images.length,1);
 assert.ok(requests.every(row=>row.url==='https://provider.test/v1/images/edits'));const multipart=Buffer.from(requests.at(-1).options.extraData).toString('latin1');assert.ok(multipart.includes('name="image"'));assert.ok(multipart.includes('name="image[]"'));assert.ok(!multipart.includes('name="response_format"'),'rejected optional response_format retries without it');
 const gemini=new OpenAICompatClient('https://generativelanguage.googleapis.com/v1beta','KEY','gemini-flash-image','gemini','apiKey','','session');const geminiBody=JSON.parse(gemini.payload([input],'','high',true));assert.deepEqual(geminiBody.generationConfig.responseModalities,['TEXT','IMAGE']);assert.ok(!geminiBody.generationConfig.thinkingConfig);assert.ok(!geminiBody.tools);
 const codex=new OpenAICompatClient('https://api.openai.com/v1','KEY','gpt-5.1-codex','openAI','oauth','','session');assert.ok(JSON.parse(codex.payload([input],'','',true)).tools.some(tool=>tool.type==='image_generation'));
 const streamClient=new OpenAICompatClient('https://router.test/v1','KEY','gemini-flash-image','openRouter','apiKey','','session');let nativeRequest;
 const oldCreate=http.createHttp;http.createHttp=()=>{nativeRequest=oldCreate();return nativeRequest;};
 const streamed=new Promise((resolve,reject)=>streamClient.streamTurn([input],'','',()=>{},resolve,reject));await Promise.resolve();
 nativeRequest.handlers.dataReceive(array(Buffer.from('data: '+JSON.stringify(fixtures[2])+'\n\n')));nativeRequest.handlers.dataEnd();const streamedTurn=await streamed;assert.equal(streamedTurn.images.length,1);
 for(const [model,mode,endpoint,event,end] of [
  ['gpt-5.6-luna','responses','/responses',{type:'response.output_text.delta',delta:'ok'},{type:'response.completed',response:{status:'completed'}}],
  ['opencode-go/MiniMax-M2.7','anthropic','/messages',{type:'content_block_delta',delta:{text:'ok'}},{type:'message_stop'}],
  ['qwen3.8-max','anthropic','/messages',{type:'content_block_delta',delta:{text:'ok'}},{type:'message_stop'}],
  ['glm-5.3','openai','/chat/completions',{choices:[{delta:{content:'ok'}}]},{choices:[{finish_reason:'stop'}]}]
 ]){
  const go=new OpenAICompatClient('https://opencode.ai/zen/go/v1','GO_KEY',model,'openCodeGo','apiKey','','bound-session');assert.equal(go.mode,mode);
  const done=new Promise((resolve,reject)=>go.streamTurn([input],'system','',()=>{},resolve,reject));await Promise.resolve();
  const request=requests.at(-1);assert.equal(request.url,'https://opencode.ai/zen/go/v1'+endpoint);assert.equal(request.options.header['x-opencode-session'],'bound-session');assert.equal(request.options.header.Authorization,'Bearer GO_KEY');
  const payload=JSON.parse(request.options.extraData);assert.ok(!(payload.tools||[]).some(tool=>tool.type==='image_generation'),'third-party Responses does not inherit official image tool');
  nativeRequest.handlers.dataReceive(array(Buffer.from('data: '+JSON.stringify(event)+'\n\ndata: '+JSON.stringify(end)+'\n\n')));nativeRequest.handlers.dataEnd();assert.equal((await done).text,'ok');
 }
 assert.equal(models.openCodeWire('gpt-any',JSON.stringify({provider:{npm:'@ai-sdk/anthropic'}})),'anthropic','declared catalog transport wins over family fallback');
 // Native HTTP may deliver the error body/dataEnd before resolving its status promise.
 for(const status of [503,429,400]){
  let releaseStatus;let errorRequest;let observed='';let painted='';
  http.createHttp=()=>{const handlers={};errorRequest={on:(name,callback)=>handlers[name]=callback,destroy(){},handlers,requestInStream:()=>new Promise(resolve=>releaseStatus=resolve)};return errorRequest;};
  streamClient.streamTurn([input],'','',delta=>painted+=delta,()=>{throw new Error('error response cannot succeed');},message=>{observed=message;});
  errorRequest.handlers.dataReceive(array(Buffer.from('{"error":{"message":"provider detail"}}')));errorRequest.handlers.dataEnd();assert.equal(observed,'','body-first error waits for the HTTP identity');
  releaseStatus(status);await Promise.resolve();assert.match(observed,new RegExp('^http '+status));assert.equal(protocol.shouldFailover(observed),status!==400);
  errorRequest.handlers.dataReceive(array(Buffer.from('data: {"choices":[{"delta":{"content":"LATE_FAILED_STREAM"}}]}\n\n')));errorRequest.handlers.dataEnd();assert.equal(painted,'','failed native streams cannot paint late data into another request');
 }
 http.createHttp=oldCreate;
 const atomic=load('store/AtomicFile.ets',{fileIo:io,util});const sessions=load('store/SessionStore.ets',{...protocol,...atomic,fileIo:io,util,image});const store=new sessions.SessionStore();const session=await store.create(context);
 const {ChatRun,PendingImage}=load('local/ChatRun.ets',{...protocol,...media,...sessions,sessionStore:store,fileIo:io,util,usageStore:{add:async()=>{}},ChatViewState:{admitted(){}}});
 const run=new ChatRun(context,session.id);run.changed=()=>{};run.finish=(gen,outcome)=>{assert.equal(gen,0);assert.equal(outcome,'done');};
 await run.completeTurn(0,{text:'a generated result',calls:[],images:[candidate],promptTokens:1,completionTokens:1});
 const disk=JSON.parse(fs.readFileSync(path.join(temp,'sessions',session.id+'.json'),'utf8'));assert.equal(disk.messages[0].images.length,1);assert.equal(disk.messages[0].images[0].b64,'');assert.equal(disk.messages[0].images[0].generated,true);assert.ok(!JSON.stringify(disk).includes('PRIVATE_SIGNED_TOKEN'));
 const restart=new sessions.SessionStore();const restored=await restart.get(context,session.id);assert.equal(restored.messages[0].images[0].b64,png.toString('base64'),'process restart restores generated image bytes for reference input');
 const stopped=new ChatRun(context,session.id);stopped.changed=()=>{};stopped.runGen=2;await stopped.completeTurn(1,{text:'stale',calls:[],images:[candidate]});assert.equal((await store.get(context,session.id)).messages.length,1,'late old media completion cannot append to the new generation');
 const firstPhoto=path.join(temp,'picked-a.png'),secondPhoto=path.join(temp,'picked-b.png');fs.writeFileSync(firstPhoto,png);fs.writeFileSync(secondPhoto,png);
 const picker={PhotoSelectOptions:class{},PhotoViewMIMETypes:{IMAGE_TYPE:'image'},PhotoViewPicker:class{async select(options){assert.equal(options.maxSelectNumber,16);return{photoUris:[firstPhoto,secondPhoto]};}}};
 const {Attachments}=load('chat/Attachments.ets',{fileIo:io,util,imageKit:image,picker,PendingImage,SessionStore:sessions.SessionStore});
 const picked=await Attachments.pickImages(context);assert.equal(picked.length,2);assert.notEqual(picked[0].path,picked[1].path,'each gallery image has a distinct owned file');
 shortRead=true;await assert.rejects(Attachments.pickImages(context),/读取不完整/);shortRead=false;
 console.log('HARMONY_CHAT_MEDIA_OK actual ETS four output parsers, anonymous bounded media persistence/cancel, four multi-image inputs, image endpoints/multipart/retry, Gemini modality, Responses image tool, stream images, ChatRun and cold restart');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
