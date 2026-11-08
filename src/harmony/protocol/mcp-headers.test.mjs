// Actual MCP store mutations and HTTP header construction with native service adapters.
import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {stripTypeScriptTypes} from 'node:module';import {randomUUID} from 'node:crypto';
const root=new URL('../app/entry/src/main/ets/',import.meta.url);
function load(file,names,env={}){const source=fs.readFileSync(new URL(file,root),'utf8').replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm,'').replace(/\bexport /g,'');const context=vm.createContext({console,setTimeout,clearTimeout,setInterval,clearInterval,Date,...env});vm.runInContext(stripTypeScriptTypes(source,{mode:'strip'})+'\nObject.assign(globalThis,{'+names.join(',')+'});',context);return Object.fromEntries(names.map(name=>[name,context[name]]));}
const disk=new Map(),secrets=new Map(),requests=[];let releaseResponse;
class AtomicTextFile{observed=new Map();read(path){const value=disk.get(path)||'';this.observed.set(path,value);return value;}write(path,value){assert.equal(disk.get(path)||'',this.observed.get(path)||'');disk.set(path,value);this.observed.set(path,value);}}
const BoundSecret={stage:async(binding,value)=>{const ref='generation-'+randomUUID();secrets.set(ref,{binding,value});return ref;},read:async(ref,binding)=>secrets.get(ref)?.binding===binding?secrets.get(ref).value:'',retire:async ref=>secrets.delete(ref)};
const env={MCP_KEY:'EXPANDED_HEADER_SECRET'};
const http={RequestMethod:{POST:'POST'},HttpDataType:{STRING:'STRING'},createHttp:()=>({destroy(){},async request(destination,options){requests.push({destination,options});if(releaseResponse)await releaseResponse;return{responseCode:200,result:'{}'};}})};
const oauth={attachContext(){},authorization:async()=>null,unchanged:()=>true,purge:async()=>{}};
const runtime=load('store/McpStore.ets',['McpStore','McpServer'],{AtomicTextFile,BoundSecret,http,McpStdio:{attachContext(){},closeLabel(){}},McpOAuth:oauth,SecretStore:{read:async()=>'',remove:async()=>{}},
 envStore:{expand:value=>value.replace(/\$\$(\w+)/g,(match,name)=>env[name]===undefined?match:JSON.stringify(env[name]).slice(1,-1))},requireProviderRoot:value=>value,MCP_PROTOCOL_VERSION:'2025-06-18'});
runtime.McpStore.listTools=async()=>'';const store=new runtime.McpStore(),context={filesDir:'/headers-fixture'};
await store.upsert(context,'service','https://mcp.example/mcp','BEARER_SECRET',{'X-Api-Key':'$$MCP_KEY','X-Tenant':'alpha'});
let row=store.find('service');await runtime.McpStore.post(row,'{}',1000);
assert.equal(requests.at(-1).options.header.Authorization,'Bearer BEARER_SECRET');assert.equal(requests.at(-1).options.header['X-Api-Key'],'EXPANDED_HEADER_SECRET');assert.equal(requests.at(-1).options.header['X-Tenant'],'alpha');assert.equal(requests.at(-1).options.maxRedirects,0);
const metadata=disk.get('/headers-fixture/mcp.json');for(const secret of ['BEARER_SECRET','EXPANDED_HEADER_SECRET','$$MCP_KEY'])assert.equal(metadata.includes(secret),false,'header values and bearer never in metadata');
assert.deepEqual(JSON.parse(metadata).rows[0].headers,{'X-Api-Key':'','X-Tenant':''});
const fresh=new runtime.McpStore();await fresh.load(context);row=fresh.find('service');await runtime.McpStore.post(row,'{}',1000);assert.equal(requests.at(-1).options.header['X-Api-Key'],'EXPANDED_HEADER_SECRET');
for(const header of [{'Host':'evil.example'},{'X-Key':'bad\r\nInjected: yes'},{'X-Key':'a','x-key':'b'},{'Mcp-Session-Id':'override'}])assert.throws(()=>runtime.McpStore.validateHeaders(header));
const count=requests.length;await assert.rejects(runtime.McpStore.post({...row,url:'https://evil.example/mcp'},'{}',1000),/配置已改变/);assert.equal(requests.length,count);
const beforeMetadataRef=row.secretRef;await fresh.mergeHTTPPublicMetadata(context,'service','https://mcp.example/mcp',['X-Api-Key','X-Tenant'],true);assert.equal(fresh.find('service').secretRef,beforeMetadataRef,'same-destination public import preserves local header generation');
await fresh.mergeHTTPPublicMetadata(context,'service','https://mcp.example/mcp',['X-Api-Key','X-Tenant','X-New'],true);const pendingHeaders=fresh.find('service');assert.equal(pendingHeaders.needsLocalHeaders,true);const beforePending=requests.length;await assert.rejects(runtime.McpStore.post(pendingHeaders,'{}',1000),/本机配置/);assert.equal(requests.length,beforePending);
await fresh.upsert(context,'service','https://mcp.example/mcp','',{'authorization':'Basic MANUAL'});row=fresh.find('service');
oauth.authorization=async()=>({header:'Bearer OAUTH',record:{}});
await runtime.McpStore.post(row,'{}',1000);const names=Object.keys(requests.at(-1).options.header).filter(name=>name.toLowerCase()==='authorization');assert.deepEqual(names,['Authorization']);assert.equal(requests.at(-1).options.header.Authorization,'Bearer OAUTH','OAuth replaces, not duplicates, manual authorization');
oauth.authorization=async()=>null;
console.log('MCP_HEADERS_ACTUAL_ETS_OK encrypted immutable generations, runtime env expansion, reload, credential-origin binding, reserved/CRLF/duplicate guards, no redirects and single Authorization');
