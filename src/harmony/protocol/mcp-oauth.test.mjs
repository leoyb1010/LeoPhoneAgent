// Real production OAuth protocol/store/controller with native IO/HTTP adapters.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
const root=new URL('../app/entry/src/main/ets/',import.meta.url);
function load(file,names,env={}){
 const source=fs.readFileSync(new URL(file,root),'utf8').replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm,'').replace(/\bexport /g,'');
 const context=vm.createContext({console,setTimeout,clearTimeout,setInterval,clearInterval,Date,...env});
 vm.runInContext(stripTypeScriptTypes(source,{mode:'strip'})+'\nObject.assign(globalThis,{'+names.join(',')+'});',context);
 return Object.fromEntries(names.map(name=>[name,context[name]]));
}
const util={generateRandomUUID:()=>randomUUID(),TextEncoder:class{encodeInto(s){return new TextEncoder().encode(s);}},Base64Helper:class{encodeToStringSync(bytes){return Buffer.from(bytes).toString('base64');}}};
const cryptoFramework={createRandom:()=>({generateRandom:async n=>({data:new Uint8Array(randomBytes(n))})}),createMd:()=>{const hash=createHash('sha256');return{update:async value=>hash.update(value.data),digest:async()=>({data:new Uint8Array(hash.digest())})};}};
const protocol=load('local/McpOAuthProtocol.ets',['McpOAuthConfig','McpOAuthTokens','oauthHTTPS','oauthResource','oauthIssuer','oauthMetadataCandidates','oauthServerMetadata','oauthRedirect','oauthCallback','oauthOwnedCallback','oauthForm','oauthTokenReply'],{url:{URL}});
assert.throws(()=>protocol.oauthHTTPS('http://issuer.example/token'));
assert.throws(()=>protocol.oauthHTTPS('https://user:password@issuer.example/token'));
assert.throws(()=>protocol.oauthRedirect('https://evil.example/callback'));
assert.throws(()=>protocol.oauthServerMetadata({issuer:'https://issuer.example/Tenant',authorization_endpoint:'https://issuer.example/authorize',token_endpoint:'https://issuer.example/token',code_challenge_methods_supported:['S256']},'https://issuer.example/tenant'),/签发者/);
assert.throws(()=>protocol.oauthServerMetadata({issuer:'https://issuer.example/',authorization_endpoint:'https://issuer.example/authorize',token_endpoint:'https://issuer.example/token',code_challenge_methods_supported:['plain']},'https://issuer.example'),/S256/);
const disk=new Map(),secretGenerations=new Map();
class AtomicTextFile{snapshots=new Map();read(path){const value=disk.get(path)||'';this.snapshots.set(path,value);return value;}write(path,value){assert.equal(disk.get(path)||'',this.snapshots.get(path)||'','stale OAuth file rejected');disk.set(path,value);this.snapshots.set(path,value);}}
const BoundSecret={stage:async(binding,value)=>{const id='generation-'+randomUUID();secretGenerations.set(id,{binding,value});return id;},read:async(id,binding)=>{const value=secretGenerations.get(id);return value?.binding===binding?value.value:'';},retire:async id=>secretGenerations.delete(id)};
const store=load('local/McpOAuthStore.ets',['McpOAuthRecord','McpOAuthStore'],{...protocol,util,AtomicTextFile,BoundSecret});
const requests=[];let challenge='',tokenCount=0,refreshCount=0,holdRefresh=null,redirectToken=false;
const http={RequestMethod:{GET:'GET',POST:'POST'},HttpDataType:{STRING:'STRING'},createHttp:()=>({destroy(){},async request(endpoint,options){
 requests.push({endpoint,options});assert.equal(options.maxRedirects,0);assert.equal(options.usingCache,false);assert.equal(options.header.Authorization,undefined);
 let value,code=200;
 if(endpoint==='https://mcp.example/.well-known/oauth-protected-resource/mcp')value={resource:'https://mcp.example/mcp',authorization_servers:['https://issuer.example/tenant'],scopes_supported:['read']};
 else if(endpoint==='https://issuer.example/.well-known/oauth-authorization-server/tenant')value={issuer:'https://issuer.example/tenant',authorization_endpoint:'https://issuer.example/authorize',token_endpoint:'https://issuer.example/token',registration_endpoint:'https://issuer.example/register',code_challenge_methods_supported:['S256']};
 else if(endpoint==='https://issuer.example/register'){const registration=JSON.parse(options.extraData);assert.deepEqual(registration.redirect_uris,['leobot://mcp/oauth/callback']);value={client_id:'fixture-client',client_secret:'MCP_CLIENT_SECRET'};}
 else if(endpoint==='https://issuer.example/token'){
  if(redirectToken)return {responseCode:302,result:'',header:{Location:'https://evil.example/token'}};
  const form=new URLSearchParams(options.extraData);assert.equal(form.get('resource'),'https://mcp.example/mcp');assert.equal(form.get('client_secret'),'MCP_CLIENT_SECRET');
  if(form.get('grant_type')==='authorization_code'){tokenCount++;assert.equal(form.get('code'),'fixture-code');assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'),challenge);value={access_token:'ACCESS-'+tokenCount,refresh_token:'REFRESH-1',expires_in:3600,token_type:'Bearer'};}
  else{refreshCount++;if(holdRefresh)await holdRefresh;value={access_token:'REFRESHED-'+refreshCount,refresh_token:'REFRESH-'+(refreshCount+1),expires_in:3600,token_type:'Bearer'};}
 }else{code=404;value={};}
 return {responseCode:code,result:JSON.stringify(value)};
}})};
const network=load('local/McpOAuthNetwork.ets',['McpOAuthNetwork'],{...protocol,http});
const oauth=load('local/McpOAuth.ets',['McpOAuth','McpOAuthSession','McpOAuthAuthorization'],{...protocol,...store,...network,http,util,url:{URL},cryptoFramework,McpOAuthLoopback:class{async start(){}close(){}}});
oauth.McpOAuth.attachContext({filesDir:'/oauth-fixture'});
const config=new protocol.McpOAuthConfig();
const beforeCredentialURL=requests.length;
await assert.rejects(oauth.McpOAuth.begin('query-credentials','https://mcp.example/mcp?api_key=PRIVATE_QUERY&tenant=alpha',config,''),/查询凭据/);assert.equal(requests.length,beforeCredentialURL,'legacy query credentials rejected before discovery or token traffic');
for(const field of ['token','access_token','API-KEY','exaApiKey','%61pi_key','%2561pi_key'])assert.throws(()=>protocol.oauthResource('https://mcp.example/mcp?'+field+'=PRIVATE_QUERY&tenant=alpha'),/查询凭据/);
assert.equal(protocol.oauthResource('https://mcp.example/mcp?tenant=alpha%2Fbeta&version=2#local-fragment'),'https://mcp.example/mcp?tenant=alpha%2Fbeta&version=2');
assert.ok(protocol.oauthMetadataCandidates('https://mcp.example/mcp?tenant=alpha%2Fbeta',true)[0].endsWith('?tenant=alpha%2Fbeta'));
const flow=await oauth.McpOAuth.begin('fixture','https://mcp.example/mcp',config,'');
const authorize=new URL(flow.authorizationURL);challenge=authorize.searchParams.get('code_challenge');
assert.equal(authorize.searchParams.get('resource'),'https://mcp.example/mcp');assert.equal(authorize.searchParams.get('code_challenge_method'),'S256');
const state=authorize.searchParams.get('state');const callback='leobot://mcp/oauth/callback?code=fixture-code&state='+encodeURIComponent(state);
await assert.rejects(flow.complete('leobot://mcp/oauth/callback?code=fixture-code&state=wrong'),/state/);assert.equal(tokenCount,0);
await assert.rejects(flow.complete(callback+'&state=second'),/state/);assert.equal(tokenCount,0);
await assert.rejects(flow.complete(callback.replace('leobot://mcp','leobot://spoof@mcp')),/归属/);assert.equal(tokenCount,0);
const first=flow.complete(callback);await assert.rejects(flow.complete(callback),/已处理/);await first;assert.equal(tokenCount,1);
assert.equal(oauth.McpOAuth.capture(callback),true,'replayed OAuth callback is consumed instead of becoming a draft');assert.equal(tokenCount,1);
assert.equal(oauth.McpOAuth.capture('leobot://mcp/oauth/callback?code=other&state=wrong'),true);assert.equal(oauth.McpOAuth.capture('leobot://chat?text=hello'),false);
const receipt=await oauth.McpOAuth.authorization('fixture','https://mcp.example/mcp',()=>true);assert.equal(receipt.header,'Bearer ACCESS-1');assert.equal(oauth.McpOAuth.current(receipt),true);
const metadata=disk.get('/oauth-fixture/mcp-oauth.json');for(const secret of ['ACCESS-1','REFRESH-1','MCP_CLIENT_SECRET'])assert.equal(metadata.includes(secret),false,'metadata never contains OAuth secrets');
const publicConfig=oauth.McpOAuth.exportPublicMetadata('fixture','https://mcp.example/mcp');assert.equal(publicConfig.clientId,'fixture-client');for(const field of ['accessToken','refreshToken','clientSecret','secretRef'])assert.equal(Object.hasOwn(publicConfig,field),false);
const stableRef=store.McpOAuthStore.read('fixture').secretRef;const beforePublicMerge=requests.length;
await oauth.McpOAuth.mergePublicMetadata({filesDir:'/oauth-fixture'},'fixture','https://mcp.example/mcp',{mode:'dynamic',clientId:flow.config.clientId,authorizationEndpoint:flow.config.authorizationEndpoint,tokenEndpoint:flow.config.tokenEndpoint,redirectURI:flow.config.redirectURI});
assert.equal(store.McpOAuthStore.read('fixture').secretRef,stableRef,'iOS missing issuer/registration/scopes does not clear a matching local authorization');assert.equal(requests.length,beforePublicMerge,'metadata merge does not run discovery or token requests');
let old=store.McpOAuthStore.read('fixture'),tokens=await store.McpOAuthStore.tokens(old);tokens.expiresAt=Date.now()-1;
await store.McpOAuthStore.commit(old,tokens,old.revision,old.secretRef,()=>true);
let releaseRefresh;holdRefresh=new Promise(resolve=>releaseRefresh=resolve);let currentA=true;
const a=oauth.McpOAuth.authorization('fixture','https://mcp.example/mcp',()=>currentA);a.catch(()=>{});
const b=oauth.McpOAuth.authorization('fixture','https://mcp.example/mcp',()=>true);
await new Promise(resolve=>setTimeout(resolve,20));currentA=false;releaseRefresh();
await assert.rejects(a,/取消/);const winner=await b;assert.ok(winner.header.startsWith('Bearer REFRESHED-'));assert.equal(refreshCount,1,'one refresh serves concurrent callers despite first caller cancellation');assert.equal(oauth.McpOAuth.current(receipt),true,'normal token rotation preserves in-flight authorization identity');
let releaseOld;holdRefresh=new Promise(resolve=>releaseOld=resolve);
const stale=oauth.McpOAuth.refresh('fixture','https://mcp.example/mcp',()=>true);stale.catch(()=>{});
await new Promise(resolve=>setTimeout(resolve,20));await oauth.McpOAuth.signOut('fixture');releaseOld();
await assert.rejects(stale);assert.equal(oauth.McpOAuth.current(receipt),false,'sign-out invalidates in-flight authorization identity');const signedOut=store.McpOAuthStore.read('fixture');assert.equal((await store.McpOAuthStore.tokens(signedOut)).accessToken,'','late refresh cannot restore logged-out generation');
holdRefresh=null;redirectToken=true;
await assert.rejects(new network.McpOAuthNetwork().json('https://issuer.example/token',http.RequestMethod.POST,'code=private','application/x-www-form-urlencoded'),/重定向/);
assert.equal(requests.some(request=>request.endpoint.startsWith('https://evil.')),false);
console.log('MCP_OAUTH_ACTUAL_ETS_OK discovery/DCR/resource binding, PKCE, one-use state/callback, secret generations, shared refresh cancellation, stale-refresh rejection and no redirects');
