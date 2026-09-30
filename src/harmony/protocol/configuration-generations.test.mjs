// ROUND1 counterexamples, converted to passing invariants on actual ETS stores.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {randomUUID} from 'node:crypto';
const root=new URL('../app/entry/src/main/ets/',import.meta.url);
function load(file,names,env={}) {
  const source=fs.readFileSync(new URL(file,root),'utf8').replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm,'').replace(/\bexport\s+/g,'');
  const context=vm.createContext({console,ArrayBuffer,Uint8Array,Date,...env});
  vm.runInContext(stripTypeScriptTypes(source,{mode:'strip'})+`\nObject.assign(globalThis,{${names.join(',')}});`,context,{filename:file});
  return Object.fromEntries(names.map(name=>[name,context[name]]));
}
const util={generateRandomUUID:()=>randomUUID(),TextEncoder:class{encodeInto(s){return new TextEncoder().encode(s);}}};
let fault='',armed=false;
const lockPaths=new Map(),fds=new Map();
function fail(kind){if(armed&&fault===kind){armed=false;throw new Error('injected '+kind);}}
const fileIo={
 OpenMode:{READ_ONLY:fs.constants.O_RDONLY,READ_WRITE:fs.constants.O_RDWR,CREATE:fs.constants.O_CREAT,TRUNC:fs.constants.O_TRUNC,NOFOLLOW:fs.constants.O_NOFOLLOW,DIR:fs.constants.O_DIRECTORY},
 accessSync:fs.existsSync,readTextSync:p=>fs.readFileSync(p,'utf8'),
 openSync(p,flags){if(p.endsWith('.lock'))fail('lock-open');if(p.endsWith('.tmp'))fail('create');if(flags&fs.constants.O_DIRECTORY)fail('directory-open');const fd=fs.openSync(p,flags);fds.set(fd,p);return{fd,tryLock(){fail('lock');if(lockPaths.has(p))throw new Error('busy');lockPaths.set(p,fd);}};},
 closeSync(file){const pathname=fds.get(file.fd);const directory=fs.fstatSync(file.fd).isDirectory();for(const[p,fd]of lockPaths)if(fd===file.fd)lockPaths.delete(p);fs.closeSync(file.fd);fds.delete(file.fd);if(directory)fail('directory-close');else if(pathname?.endsWith('.tmp'))fail('file-close');},
 writeSync(fd,data){fail('write');const b=Buffer.from(data);return fs.writeSync(fd,b,0,armed&&fault==='short'?(armed=false,b.length-1):b.length);},
 fsyncSync(fd){fail(fs.fstatSync(fd).isDirectory()?'directory-fsync':'file-fsync');fs.fsyncSync(fd);},
 renameSync(a,b){fail('rename');fs.renameSync(a,b);},unlinkSync:fs.unlinkSync,
};
const secrets=new Map();let secretFault=false;
const SecretStore={
 write:async(k,v)=>{if(secretFault){secretFault=false;throw new Error('injected secret write');}secrets.set(k,v);},
 read:async k=>secrets.get(k)||'',remove:async k=>{secrets.delete(k);},
 readProviderKeyFor:async id=>secrets.get('provider.'+id)||'',removeProviderKeyFor:async id=>{secrets.delete('provider.'+id);},
 readProviderKey:async()=>secrets.get('provider.global')||'',removeProviderKey:async()=>{secrets.delete('provider.global');},
};
const atomic=load('store/AtomicFile.ets',['AtomicTextFile','atomicWriteText','AtomicCommitUncertainError'],{fileIo,util});
const bound=load('store/BoundSecret.ets',['BoundSecret'],{SecretStore,util});
const network=[];
const http={RequestMethod:{POST:'POST'},HttpDataType:{STRING:'STRING'},createHttp:()=>({
 request:async(url,options)=>{network.push([url,options.header.Authorization||'']);return{responseCode:200,result:'{}'};},destroy(){}})};
const common={fileIo,SecretStore,http,envStore:{expand:x=>x},MCP_PROTOCOL_VERSION:'test',...atomic,...bound,requireProviderRoot:x=>x,AppStorage:{setOrCreate(){}},
 kindByKey:t=>({root:'https://official.example/'+t,models:['model']}),OAUTH_ALIAS:'oauth',
 envPromptBlock:()=>'',expandEnvPlaceholders:x=>x,referencesEnv:()=>false};
const {McpStore}=load('store/McpStore.ets',['McpStore'],common);McpStore.listTools=async()=>'';
const {EnvStore}=load('store/EnvStore.ets',['EnvStore'],common);
const {ProviderStore,ProviderInstance}=load('store/ProviderStore.ets',['ProviderStore','ProviderInstance'],common);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'harmony-generation-'));
let checks=0;
const factories={
 mcp:{create:()=>new McpStore(),file:'mcp.json',load:(s,c)=>s.load(c),upsert:(s,c,target,key)=>s.upsert(c,'service',target,key),remove:(s,c)=>s.remove(c,'service'),pair:s=>s.rows[0]?[s.rows[0].url,s.rows[0].secret]:[],row:s=>s.rows[0]},
 env:{create:()=>new EnvStore(),file:'env.json',load:(s,c)=>s.load(c),upsert:(s,c,target,key)=>s.upsert(c,'ENV',key),remove:(s,c)=>s.remove(c,'ENV'),pair:s=>s.rows[0]?['ENV',s.rows[0].value]:[],row:s=>s.rows[0]},
 provider:{create:()=>new ProviderStore(),file:'providers.json',load:(s,c)=>s.ensureLoaded(c),upsert:(s,c,target,key)=>{const row=new ProviderInstance();Object.assign(row,{id:'p',type:'custom',baseUrl:target,model:'model',label:'service'});return s.upsert(c,row,key);},remove:(s,c)=>s.remove(c,'p'),pair:s=>s.instances[0]?[s.instances[0].baseUrl,s.keyFor('p')]:[],row:s=>s.instances[0]},
};
async function setup(kind){const c={filesDir:fs.mkdtempSync(path.join(temp,kind+'-'))},f=factories[kind],s=f.create();await f.load(s,c);await f.upsert(s,c,'https://a.example','KEY_A');return{c,f,s};}
async function fresh(f,c){const n=f.create();await f.load(n,c);return n;}
const expected=(kind,target,key)=>[kind==='env'?'ENV':target,key];
try{
 for(const kind of Object.keys(factories)){
  for(const point of ['lock-open','lock','create','write','short','file-fsync','file-close','rename','directory-open','directory-fsync','directory-close']){
   const {c,f,s}=await setup(kind),before=f.row(s).secretRef;
   fault=point;armed=true;
   await assert.rejects(f.upsert(s,c,'https://b.example','KEY_B'));
   armed=false;
   const committed=point.startsWith('directory-');
   const pair=expected(kind,committed?'https://b.example':'https://a.example',committed?'KEY_B':'KEY_A');
   assert.deepEqual(Array.from(f.pair(await fresh(f,c))),pair,`${kind} ${point} fresh pair`);
   assert.deepEqual(Array.from(f.pair(s)),pair,`${kind} ${point} active pair`);
   assert.ok(secrets.has(before),'uncertain/failed mutation preserves old generation');
   await f.upsert(s,c,'https://c.example','KEY_C');
   assert.deepEqual(Array.from(f.pair(await fresh(f,c))),expected(kind,'https://c.example','KEY_C'),'same-instance recovery');
   checks++;
  }
  const secretCase=await setup(kind);secretFault=true;
  await assert.rejects(secretCase.f.upsert(secretCase.s,secretCase.c,'https://b.example','KEY_B'),/secret write/);
  assert.deepEqual(Array.from(secretCase.f.pair(await fresh(secretCase.f,secretCase.c))),expected(kind,'https://a.example','KEY_A'));
  // Both old reviewer repros: ordinary rename failure and stale upsert can never mix the pair.
  const {c,f,s}=await setup(kind);const stale=await fresh(f,c),staleDelete=await fresh(f,c);
  await f.upsert(s,c,'https://b.example','KEY_B');const winning=f.row(s).secretRef;
  await assert.rejects(f.upsert(stale,c,'https://a.example','KEY_A'),/另一进程/);
  await assert.rejects(f.remove(staleDelete,c),/另一进程/);
  assert.ok(secrets.has(winning),'stale remove did not delete winner');
  assert.deepEqual(Array.from(f.pair(await fresh(f,c))),expected(kind,'https://b.example','KEY_B'));
  await stale.reload(c);await f.upsert(stale,c,'https://c.example','KEY_C');
  assert.deepEqual(Array.from(f.pair(await fresh(f,c))),expected(kind,'https://c.example','KEY_C'));
  for(const point of ['lock-open','lock','create','write','short','file-fsync','file-close','rename','directory-open','directory-fsync','directory-close']){
   const current=await fresh(f,c);if(!f.row(current))await f.upsert(current,c,'https://c.example','KEY_C');
   const old=f.row(current).secretRef;fault=point;armed=true;
   await assert.rejects(f.remove(current,c));armed=false;
   assert.ok(secrets.has(old),'failed/uncertain removal preserved credentials');
   const next=await fresh(f,c);
   assert.deepEqual(Array.from(f.pair(next)),point.startsWith('directory-')?[]:expected(kind,'https://c.example','KEY_C'));
   checks++;
  }
  const final=await fresh(f,c);await f.upsert(final,c,'https://final.example','FINAL');const last=f.row(final).secretRef;
  await f.remove(final,c);assert.ok(!secrets.has(last),'successful removal retires only old generation');
  assert.deepEqual(Array.from(f.pair(await fresh(f,c))),[]);checks++;
 }
 for(const kind of Object.keys(factories)) {
  const {c,f,s}=await setup(kind);
  await Promise.all([f.upsert(s,c,'https://b.example','KEY_B'),f.upsert(s,c,'https://c.example','KEY_C'),s.reload(c)]);
  assert.deepEqual(Array.from(f.pair(await fresh(f,c))),expected(kind,'https://c.example','KEY_C'));
 }
 for(const [page,store]of [['EnvPage','envStore'],['McpPage','mcpStore']]) {
  const src=fs.readFileSync(new URL(`pages/${page}.ets`,root),'utf8');
  assert.ok(src.includes(`${store}.reload(ctx)`));assert.ok(src.includes(`this.rows = ${store}.rows.slice()`));
 }
 // Binding is checked when retrieving a credential, even with a valid reference.
 const {c,f,s}=await setup('mcp');const row=f.row(s);const altered={...row,url:'https://wrong.example'};
 assert.equal(await McpStore.secretFor(altered),'');
 await McpStore.post(row,'{}',100);assert.deepEqual(network.at(-1),['https://a.example','Bearer KEY_A']);
 await McpStore.post(altered,'{}',100);assert.deepEqual(network.at(-1),['https://wrong.example','']);
 // Empty token on changed endpoint is explicit; legacy alias cannot be reused.
 secrets.set('leo.harmony.mcp.service','LEGACY');await f.upsert(s,c,'https://other.example','');
 const noToken=await fresh(f,c);assert.equal(await McpStore.secretFor(f.row(noToken)),'');
 // A secret-write failure is pre-commit and preserves active/persisted original pair.
 secretFault=true;await assert.rejects(f.upsert(s,c,'https://secret-failure.example','NEW'));
 assert.deepEqual(Array.from(f.pair(await fresh(f,c))),['https://other.example','']);
 // Legacy aliases/plaintext migrate to immutable references without losing the old pair.
 for(const kind of ['mcp','env','provider']) {
  const f=factories[kind],c={filesDir:fs.mkdtempSync(path.join(temp,'legacy-'+kind))};
  const metadata=kind==='mcp'?{rows:[{label:'service',url:'https://a.example',secret:'KEY_A'}]}:
    kind==='env'?{rows:[{name:'ENV',value:'KEY_A'}]}:
    {activeId:'p',instances:[{id:'p',type:'custom',baseUrl:'https://a.example',model:'model'}],groups:[]};
  if(kind==='provider')secrets.set('provider.p','KEY_A');
  fs.writeFileSync(path.join(c.filesDir,f.file),JSON.stringify(metadata));
  const loaded=await fresh(f,c);
  assert.deepEqual(Array.from(f.pair(loaded)),expected(kind,'https://a.example','KEY_A'));
  const text=fs.readFileSync(path.join(c.filesDir,f.file),'utf8');
  assert.ok(!text.includes('KEY_A'));assert.ok(text.includes('secretRef'));
 }
 // Failed secret reads cannot be misinterpreted as an explicit empty token and saved.
 const unread=await setup('provider'),ref=unread.f.row(unread.s).secretRef,saved=secrets.get(ref);secrets.delete(ref);
 await assert.rejects(fresh(unread.f,unread.c),/凭据暂不可读/);secrets.set(ref,saved);
 assert.deepEqual(Array.from(unread.f.pair(await fresh(unread.f,unread.c))),['https://a.example','KEY_A']);
 // OAuth uses the same generation commit; failed/stale refresh never changes the stored pair.
 const oc={filesDir:fs.mkdtempSync(path.join(temp,'oauth-'))},provider=new ProviderStore();await provider.ensureLoaded(oc);
 const oauthRow=new ProviderInstance();Object.assign(oauthRow,{id:'oauth',type:'openAI',credential:'oauth',model:'model'});
 await provider.upsert(oc,oauthRow,'ACCESS_A');
 let oauthRef=provider.credentialReference('oauth');secrets.set('oauth.'+oauthRef,'REFRESH_A');
 fault='rename';armed=true;await assert.rejects(provider.commitRefreshedKey('oauth',oauthRef,'ACCESS_B','REFRESH_B'));armed=false;
 assert.equal(provider.keyFor('oauth'),'ACCESS_A');assert.equal(secrets.get('oauth.'+provider.credentialReference('oauth')),'REFRESH_A');
 await provider.commitRefreshedKey('oauth',oauthRef,'ACCESS_B','REFRESH_B');
 const refreshed=provider.credentialReference('oauth');assert.notEqual(refreshed,oauthRef);
 assert.equal(provider.keyFor('oauth'),'ACCESS_B');assert.equal(secrets.get('oauth.'+refreshed),'REFRESH_B');
 await assert.rejects(provider.commitRefreshedKey('oauth',oauthRef,'STALE','STALE'));
 assert.equal(provider.keyFor('oauth'),'ACCESS_B');
 const {OAuthSession}=load('local/OAuthSession.ets',['OAuthSession'],{SecretStore,providerStore:provider,OAUTH_ALIAS:'oauth'});
 OAuthSession.lastRefresh='NEXT';OAuthSession.lastType='openAI';
 await assert.rejects(OAuthSession.bind('oauth','WRONG_ACCESS'));
 await OAuthSession.bind('oauth','ACCESS_B');
 assert.equal(JSON.parse(secrets.get('oauth.'+refreshed)).refresh,'NEXT');
 // Group cleanup remains part of the actual provider remove transaction.
 provider.groups=[{id:'g',name:'group',modelIds:['openAI/model']}];provider.activeGroupId='g';await provider.save(oc);
 await provider.remove(oc,'oauth');assert.equal(provider.groups.length,0);assert.equal(provider.activeGroupId,'');
 // Exact post-rename writer repro: failure remains visible, snapshot is reconciled.
 const target=path.join(temp,'uncertain.json');fs.writeFileSync(target,'old');const writer=new atomic.AtomicTextFile();writer.read(target);
 fault='directory-fsync';armed=true;assert.throws(()=>writer.write(target,'new'),atomic.AtomicCommitUncertainError);armed=false;
 assert.equal(fs.readFileSync(target,'utf8'),'new');writer.write(target,'newer');assert.equal(fs.readFileSync(target,'utf8'),'newer');
 console.log(`HARMONY_GENERATION_TRANSACTION_OK ${checks} store fault/removal scenarios + stale writers + recovery`);
}finally{fs.rmSync(temp,{recursive:true,force:true});}
