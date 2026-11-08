// Production ETS OAuth over a real local HTTPS authorization server and TCP loopback callback.
// SDK IO is adapted to Node HTTPS/net with an ephemeral fixture CA, never global trust or real accounts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import {execFileSync} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
const root=new URL('../app/entry/src/main/ets/',import.meta.url);
function load(file,names,env={}) {
  const source=fs.readFileSync(new URL(file,root),'utf8').replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm,'').replace(/\bexport /g,'');
  const context=vm.createContext({console,setTimeout,clearTimeout,setInterval,clearInterval,Date,...env});
  vm.runInContext(stripTypeScriptTypes(source,{mode:'strip'})+'\nObject.assign(globalThis,{'+names.join(',')+'});',context);
  return Object.fromEntries(names.map(name=>[name,context[name]]));
}
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'leobot-oauth-tls-'));
execFileSync('/opt/homebrew/opt/openssl@3/bin/openssl',['req','-x509','-newkey','rsa:2048','-sha256','-days','1','-nodes','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-keyout',temporary+'/key.pem','-out',temporary+'/cert.pem'],{stdio:'ignore'});
const certificate=fs.readFileSync(temporary+'/cert.pem');
let origin='',resource='',callbackURI='',challenge='',state='',grantCount=0,refreshCount=0,redirectToken=false,leaks=0;
const seen=[];
const server=https.createServer({key:fs.readFileSync(temporary+'/key.pem'),cert:certificate},async(request,response)=>{
  try {
    const target=new URL(request.url,origin);let body='';for await(const chunk of request)body+=chunk;
    seen.push({path:target.pathname,query:target.search,headers:request.headers,body});
    const json=(value,code=200)=>{response.writeHead(code,{'Content-Type':'application/json'});response.end(JSON.stringify(value));};
    if(target.pathname==='/.well-known/oauth-protected-resource/mcp')return json({resource,authorization_servers:[origin+'/issuer'],scopes_supported:['read']});
    if(target.pathname==='/.well-known/oauth-authorization-server/issuer')return json({issuer:origin+'/issuer',authorization_endpoint:origin+'/authorize',token_endpoint:origin+'/token',registration_endpoint:origin+'/register',code_challenge_methods_supported:['S256']});
    if(target.pathname==='/register'){const client=JSON.parse(body);assert.equal(client.token_endpoint_auth_method,'none');assert.deepEqual(client.redirect_uris,[callbackURI]);return json({client_id:'fixture-client',client_secret:'TLS_FIXTURE_CLIENT_SECRET'},201);}
    if(target.pathname==='/authorize'){
      assert.equal(target.searchParams.get('resource'),resource);assert.equal(target.searchParams.get('code_challenge_method'),'S256');
      challenge=target.searchParams.get('code_challenge');state=target.searchParams.get('state');const redirect=new URL(callbackURI);redirect.searchParams.set('code','fixture-code');redirect.searchParams.set('state',state);
      response.writeHead(302,{Location:redirect.toString(),'Cache-Control':'no-store'});return response.end();
    }
    if(target.pathname==='/token'){
      if(redirectToken){response.writeHead(302,{Location:origin+'/leak'});return response.end();}
      const form=new URLSearchParams(body);assert.equal(form.get('resource'),resource);assert.equal(form.get('client_id'),'fixture-client');assert.equal(form.get('client_secret'),'TLS_FIXTURE_CLIENT_SECRET');
      if(form.get('grant_type')==='authorization_code'){
        assert.equal(form.get('code'),'fixture-code');assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'),challenge);assert.equal(form.get('redirect_uri'),callbackURI);
        grantCount++;return json({access_token:'TLS_ACCESS',refresh_token:'TLS_REFRESH',token_type:'Bearer',expires_in:3600});
      }
      assert.equal(form.get('grant_type'),'refresh_token');refreshCount++;return json({access_token:'TLS_REFRESHED',refresh_token:'TLS_ROTATED',token_type:'Bearer',expires_in:3600});
    }
    if(target.pathname==='/leak'){leaks++;return json({});}
    return json({},404);
  }catch(error){response.writeHead(500);response.end('fixture assertion failed');server.fixtureError=error;}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
origin='https://localhost:'+server.address().port;resource=origin+'/mcp?tenant=alpha%2Fbeta&version=2';
const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));callbackURI='http://127.0.0.1:'+reservation.address().port+'/oauth/callback';await new Promise(resolve=>reservation.close(resolve));
const util={generateRandomUUID:()=>randomUUID(),TextEncoder:class{encodeInto(s){return new TextEncoder().encode(s);}},TextDecoder:{create:()=>{const decoder=new TextDecoder();return{decodeToString:(bytes,options)=>decoder.decode(bytes,options)}}},Base64Helper:class{encodeToStringSync(bytes){return Buffer.from(bytes).toString('base64');}}};
const cryptoFramework={createRandom:()=>({generateRandom:async n=>({data:new Uint8Array(randomBytes(n))})}),createMd:()=>{const hash=createHash('sha256');return{update:async value=>hash.update(value.data),digest:async()=>({data:new Uint8Array(hash.digest())})};}};
const protocol=load('local/McpOAuthProtocol.ets',['McpOAuthConfig','McpOAuthTokens','oauthHTTPS','oauthResource','oauthIssuer','oauthMetadataCandidates','oauthServerMetadata','oauthRedirect','oauthCallback','oauthOwnedCallback','oauthForm','oauthTokenReply'],{url:{URL}});
const disk=new Map(),secrets=new Map();
class AtomicTextFile{observed=new Map();read(name){const value=disk.get(name)||'';this.observed.set(name,value);return value;}write(name,value){assert.equal(disk.get(name)||'',this.observed.get(name)||'');disk.set(name,value);this.observed.set(name,value);}}
const BoundSecret={stage:async(binding,value)=>{const ref='generation-'+randomUUID();secrets.set(ref,{binding,value});return ref;},read:async(ref,binding)=>secrets.get(ref)?.binding===binding?secrets.get(ref).value:'',retire:async ref=>secrets.delete(ref)};
const store=load('local/McpOAuthStore.ets',['McpOAuthRecord','McpOAuthStore'],{...protocol,util,AtomicTextFile,BoundSecret});
const sdkHTTP={RequestMethod:{GET:'GET',POST:'POST'},HttpDataType:{STRING:'STRING'},createHttp:()=>{
  let active=null;return{destroy(){active?.destroy();},request(endpoint,options){
    assert.equal(options.maxRedirects,0);assert.equal(options.header.Authorization,undefined);assert.equal(options.usingCache,false);
    return new Promise((resolve,reject)=>{const request=https.request(endpoint,{method:options.method,headers:options.header,ca:certificate,rejectUnauthorized:true,agent:false},response=>{
      let body='';response.on('data',chunk=>{body+=chunk;if(Buffer.byteLength(body)>options.maxLimit)request.destroy(Error('response limit'));});response.on('end',()=>resolve({responseCode:response.statusCode,result:body,header:response.headers}));});active=request;request.on('error',reject);request.end(options.extraData||'');});
  }};
}};
const network=load('local/McpOAuthNetwork.ets',['McpOAuthNetwork'],{...protocol,http:sdkHTTP});
class NativeConnection {
  constructor(connection){this.connection=connection;}
  on(event,callback){if(event==='message')this.connection.on('data',buffer=>callback({message:buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength)}));else this.connection.on(event,callback);}
  send({data}){return new Promise((resolve,reject)=>this.connection.write(data,error=>error?reject(error):resolve()));}
  close(){return new Promise(resolve=>{if(this.connection.destroyed)return resolve();this.connection.end(resolve);});}
}
const sockets={constructTCPSocketServerInstance:()=>{let accept=null;let server=null;return{
  on(event,callback){if(event==='connect')accept=callback;},listen(address){return new Promise((resolve,reject)=>{server=net.createServer(connection=>accept(new NativeConnection(connection)));server.once('error',reject);server.listen(address.port,address.address,resolve);});},
  close(){return new Promise(resolve=>{if(!server?.listening)return resolve();server.close(resolve);});}
};}};
const loopback=load('local/McpOAuthLoopback.ets',['McpOAuthLoopback'],{...protocol,util,socket:sockets});
const controller=load('local/McpOAuth.ets',['McpOAuth','McpOAuthSession'],{...protocol,...store,...network,...loopback,http:sdkHTTP,util,cryptoFramework,url:{URL}});
controller.McpOAuth.attachContext({filesDir:'/local-https-fixture'});
const get=(target,tls=false)=>new Promise((resolve,reject)=>{
  const request=(tls?https:http).get(target,tls?{ca:certificate,rejectUnauthorized:true,agent:false}:{agent:false},response=>{let body='';response.on('data',chunk=>body+=chunk);response.on('end',()=>resolve({code:response.statusCode,body,location:response.headers.location}));});request.on('error',reject);
});
try {
  const config=new protocol.McpOAuthConfig();config.redirectURI=callbackURI;
  const before=seen.length;await assert.rejects(controller.McpOAuth.begin('bad',origin+'/mcp?api_key=QUERY_PRIVATE&tenant=alpha',config,''),/查询凭据/);assert.equal(seen.length,before);
  const flow=await controller.McpOAuth.begin('local',resource,config,'');
  const denied=await get(callbackURI+'?code=ignored&state=wrong');assert.equal(denied.code,400);assert.equal(grantCount,0);
  const completed=new Promise((resolve,reject)=>{flow.onComplete=resolve;flow.onError=message=>reject(Error(message));});
  const redirect=await get(flow.authorizationURL,true);assert.equal(redirect.code,302);
  const callback=await get(redirect.location);assert.equal(callback.code,200);await completed;
  const authorized=await controller.McpOAuth.authorization('local',resource,()=>true);assert.equal(authorized.header,'Bearer TLS_ACCESS');assert.equal(grantCount,1);
  const refreshed=await controller.McpOAuth.refresh('local',resource,()=>true);assert.equal(refreshed.header,'Bearer TLS_REFRESHED');assert.equal(refreshCount,1);
  const metadata=disk.get('/local-https-fixture/mcp-oauth.json');for(const secret of ['TLS_ACCESS','TLS_REFRESH','TLS_FIXTURE_CLIENT_SECRET'])assert.equal(metadata.includes(secret),false);
  for(const request of seen){assert.equal(request.headers.authorization,undefined);assert.equal(request.query.includes('QUERY_PRIVATE'),false);if(request.path.startsWith('/.well-known/oauth-authorization'))assert.equal(request.query,'');}
  redirectToken=true;await assert.rejects(new network.McpOAuthNetwork().json(origin+'/token',sdkHTTP.RequestMethod.POST,'code=fixture','application/x-www-form-urlencoded'),/重定向/);assert.equal(leaks,0);
  if(server.fixtureError)throw server.fixtureError;
  console.log('MCP_OAUTH_LOCAL_HTTPS_PASS real TLS discovery/DCR/authorize redirect/loopback callback/PKCE/code exchange/refresh, business resource query, credential URL rejection, no auth-header inheritance or redirects');
} finally {
  controller.McpOAuth.cancelAll();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(temporary,{recursive:true,force:true});
}
