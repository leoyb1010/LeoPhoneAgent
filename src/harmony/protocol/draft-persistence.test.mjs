// Actual production draft store and atomic writer, fresh VM instances model process restart.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
const root=new URL('../app/entry/src/main/ets/',import.meta.url);
function load(file,names,env={}){const s=fs.readFileSync(new URL(file,root),'utf8').replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm,'').replace(/\bexport\s+/g,'');const c=vm.createContext({console,setTimeout,clearTimeout,...env});vm.runInContext(stripTypeScriptTypes(s,{mode:'strip'})+`\nObject.assign(globalThis,{${names.join(',')}});`,c);return Object.fromEntries(names.map(n=>[n,c[n]]));}
let writes=0;let failRename=false;const opened=[];
const io={OpenMode:{READ_ONLY:fs.constants.O_RDONLY,READ_WRITE:fs.constants.O_RDWR,CREATE:fs.constants.O_CREAT,TRUNC:fs.constants.O_TRUNC,NOFOLLOW:fs.constants.O_NOFOLLOW,DIR:fs.constants.O_DIRECTORY},accessSync:fs.existsSync,lstatSync:fs.lstatSync,statSync:fs.statSync,
 readTextSync:p=>{opened.push(p);return fs.readFileSync(p,'utf8');},openSync:(p,f)=>{opened.push(p);return{fd:fs.openSync(p,f)};},closeSync:f=>fs.closeSync(f.fd),readSync:(fd,b)=>fs.readSync(fd,Buffer.from(b)),writeSync:(fd,b)=>{writes++;return fs.writeSync(fd,Buffer.from(b));},fsyncSync:fs.fsyncSync,
 renameSync:(a,b)=>{if(failRename)throw new Error('injected rename');fs.renameSync(a,b);},unlinkSync:fs.unlinkSync};
const util={generateRandomUUID:()=>randomUUID(),TextEncoder:class{encodeInto(text){return new TextEncoder().encode(text);}},Base64Helper:class{encodeToStringSync(bytes){return Buffer.from(bytes).toString('base64');}}};
const atomic=load('store/AtomicFile.ets',['atomicWriteText'],{fileIo:io,util});const messages=new Map();const app={get:key=>messages.get(key),setOrCreate:(key,value)=>messages.set(key,value)};
function fresh(){return load('local/ChatViewState.ets',['ChatViewState'],{...atomic,fileIo:io,util,AppStorage:app,PendingImage:class{}}).ChatViewState;}
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'harmony-drafts-'));const context={filesDir:temp};
try{
 fs.mkdirSync(path.join(temp,'workspace'));fs.mkdirSync(path.join(temp,'chat-images'));fs.mkdirSync(path.join(temp,'sessions'));
 fs.writeFileSync(path.join(temp,'workspace','note.txt'),'draft file');const image=Buffer.from([137,80,78,71]);fs.writeFileSync(path.join(temp,'chat-images','image.png'),image);
 const paneSource=fs.readFileSync(new URL('../app/entry/src/main/ets/panes/LocalChatPane.ets',import.meta.url),'utf8');
 const bootBody=paneSource.slice(paneSource.indexOf('  private boot(): void {'),paneSource.indexOf('  private attach(')).replace('private boot()','boot()');
 const saveBody=paneSource.slice(paneSource.indexOf('  private saveViewState(): void {'),paneSource.indexOf('  private restoreViewState(')).replace('private saveViewState()','saveViewState()');
 async function consumeShare(ChatViewState){let clears=0;const c=vm.createContext({ChatViewState,getContext:()=>context,providerStore:{ensureLoaded:async()=>{},configured:()=>true},sessionStore:{ensureLoaded:async()=>{},jsonLoadFailed:false},LocalTools:{hydrate:async()=>{}},SensitiveToolGate:{fullAuto:false},themeStore:{expandThinking:false},ShareInbox:{peek:async()=>({id:'share-1',text:'inbox text',files:[]}),clear:async(_ctx,id)=>{assert.equal(id,'share-1');clears++;}}});
 vm.runInContext(stripTypeScriptTypes('class Host{'+bootBody+saveBody+'} globalThis.Host=Host;',{mode:'strip'}),c);const h=new c.Host();Object.assign(h,{sessionId:'',draft:'',pendingFiles:[],pendingImages:[],pendingImagePaths:[],image:null,selectedProviderId:'',selectedModelId:'',modelPicked:false,memoryEnabled:true,openTurns:[],nearBottom:true,draftBaseline:'',filesBaseline:'[]',imageBaseline:'',chatScroller:{currentOffset:()=>({yOffset:0})},restoreViewState(){},refreshSlot(){}});h.boot();for(let i=0;i<16;i++)await Promise.resolve();return{clears,h};}
 const newBody=paneSource.slice(paneSource.indexOf('  private async newSession(): Promise<void> {'),paneSource.indexOf('  private async exportSession(')).replace('private async newSession','async newSession');
 let newRequests=0,savedBeforeNew=0;const newVm=vm.createContext({sessionStore:{create:async()=>{throw new Error('new draft must not create Session');}}});
 vm.runInContext(stripTypeScriptTypes('class DraftHost{'+newBody+'}globalThis.DraftHost=DraftHost;',{mode:'strip'}),newVm);const newHost=new newVm.DraftHost();newHost.saveViewState=()=>savedBeforeNew++;newHost.onNew=()=>newRequests++;await newHost.newSession();assert.equal(newRequests,1);assert.equal(savedBeforeNew,1,'new conversation first preserves the previous conversation draft');
 const homeSource=fs.readFileSync(new URL('panes/LocalAgentPane.ets',root),'utf8');const accessors=homeSource.slice(homeSource.indexOf('  private get homeImages():'),homeSource.indexOf('  private launched:')).replace(/private /g,'');const saveHome=homeSource.slice(homeSource.indexOf('  private saveHomeDraft():'),homeSource.indexOf('  onProviderTick():')).replace('private saveHomeDraft','saveHomeDraft');
 const canonical={draft:'canonical',files:['note.txt'],images:[{path:'one'},{path:'two'}],image:{path:'one'}};const homeContext=vm.createContext({ChatViewState:{get:()=>canonical,persistSoon(){}}});vm.runInContext(stripTypeScriptTypes('class HomeHost{'+accessors+saveHome+'}globalThis.HomeHost=HomeHost;',{mode:'strip'}),homeContext);const homeHost=new homeContext.HomeHost();homeHost.draft='typed home';homeHost.homeFiles=['note.txt'];homeHost.homeImages=undefined;homeHost.homeImage=undefined;assert.doesNotThrow(()=>homeHost.saveHomeDraft());assert.equal(canonical.images.length,2,'unbound native component cannot erase canonical image ownership');homeHost.draft=undefined;homeHost.homeFiles=undefined;assert.doesNotThrow(()=>homeHost.saveHomeDraft());assert.equal(canonical.draft,'typed home');assert.deepEqual(canonical.files,['note.txt']);
 const shareFail=fresh();failRename=true;const failedShare=await consumeShare(shareFail);assert.equal(failedShare.clears,0,'actual LocalChatPane boot retains ShareInbox on atomic draft failure');failRename=false;
 const shareSuccess=fresh();const consumed=await consumeShare(shareSuccess);assert.equal(consumed.clears,1,'actual boot acknowledges only after durable draft commit');assert.equal(JSON.parse(fs.readFileSync(path.join(temp,'chat-drafts.json'),'utf8')).rows[0].text,'inbox text');
 fs.unlinkSync(path.join(temp,'chat-drafts.json'));writes=0;
 const first=fresh();first.initialize(context);const row=first.get('');Object.assign(row,{draft:'未发送的长文本 '+ '内容'.repeat(5000),files:['note.txt'],image:{path:path.join(temp,'chat-images','image.png'),mime:'image/png',b64:image.toString('base64')},providerId:'provider-1',modelId:'brand/model',modelPicked:true,memoryEnabled:false});
 row.images=[row.image,{...row.image,path:path.join(temp,'chat-images','second.png')}];fs.writeFileSync(row.images[1].path,image);
 first.persistSoon();assert.equal(writes,0,'typing schedules IO rather than synchronously writing each key');first.flushOrThrow();const after=writes;first.flushOrThrow();assert.equal(writes,after,'unchanged snapshots do not rewrite');assert.deepEqual(fs.readdirSync(path.join(temp,'sessions')),[],'saving a draft never creates a Session');
 const second=fresh();second.initialize(context);const restored=second.get('');assert.equal(restored.draft,row.draft);assert.equal(restored.modelId,'brand/model');assert.equal(restored.memoryEnabled,false);assert.deepEqual(Array.from(restored.files),['note.txt']);assert.equal(restored.image.b64,image.toString('base64'));assert.equal(restored.images.length,2,'both gallery images survive a cold draft restore');
 second.moveDraft('','s_1_2');const id=second.beginSubmission('s_1_2');assert.ok(id);assert.equal(second.get('s_1_2').draft,row.draft);
 fs.writeFileSync(path.join(temp,'sessions','s_1_2.json'),JSON.stringify({messages:[{role:'user',submissionId:id,text:row.draft}]}));
 const admitted=fresh();admitted.initialize(context);assert.equal(admitted.get('s_1_2').draft,'','a process crash after admission cannot resurrect an already-sent draft');
 const waiting=admitted.get('s_3_4');waiting.draft='not yet admitted';admitted.beginSubmission('s_3_4');
 const pending=fresh();pending.initialize(context);assert.equal(pending.get('s_3_4').draft,'not yet admitted','unconfirmed submissions retain their original text');assert.ok(pending.get('s_3_4').submissionId);
 const pendingId=pending.get('s_3_4').submissionId;pending.get('s_3_4').draft='newer typing';pending.cancelSubmission('s_3_4');pending.admitted('s_3_4',pendingId);assert.equal(pending.get('s_3_4').draft,'newer typing','a late admission cannot clear a newer draft');
 pending.flushOrThrow();const payload=JSON.parse(fs.readFileSync(path.join(temp,'chat-drafts.json'),'utf8'));payload.rows.push({id:'home',text:'safe text',files:['../outside','link','note.txt'],imageName:'../../secret'});
 const secret=path.join(temp,'secret');fs.writeFileSync(secret,'PRIVATE');fs.symlinkSync(secret,path.join(temp,'workspace','link'));fs.writeFileSync(path.join(temp,'chat-drafts.json'),JSON.stringify(payload));opened.length=0;
 const guarded=fresh();guarded.initialize(context);assert.equal(guarded.get('home').draft,'safe text');assert.deepEqual(Array.from(guarded.get('home').files),['note.txt']);assert.equal(guarded.get('home').image,null);assert.ok(!opened.includes(secret));
 guarded.get('home').draft='shared text awaiting durable commit';let cleared=false;failRename=true;
 try{guarded.flushOrThrow();cleared=true;}catch{}assert.equal(cleared,false,'ShareInbox acknowledgement must follow durable draft commit');assert.match(messages.get('draftError'),/保存失败/);failRename=false;guarded.flushOrThrow();cleared=true;assert.equal(cleared,true);
 const original='not valid json';fs.writeFileSync(path.join(temp,'chat-drafts.json'),original);const broken=fresh();broken.initialize(context);broken.get('home').draft='RAM is preserved';assert.throws(()=>broken.flushOrThrow(),/读取失败/);assert.equal(fs.readFileSync(path.join(temp,'chat-drafts.json'),'utf8'),original);
 first.flush();second.flush();pending.flush();guarded.flush();
 console.log('HARMONY_DRAFT_PERSISTENCE_OK production ETS cold restart, no Session creation, debounce, model/privacy restore, private-path checks, durable admission and failed-commit acknowledgement');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
