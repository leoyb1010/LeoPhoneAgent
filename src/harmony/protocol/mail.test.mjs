// Execute actual mail ETS through TypeScript stripping. Socket fixtures are adapters, not native TLS evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
const root=new URL('../app/entry/src/main/ets/',import.meta.url);
const util={TextEncoder:class{encodeInto(s){return new TextEncoder().encode(s);}},TextDecoder:{create:encoding=>({decodeToString:bytes=>new TextDecoder(encoding).decode(bytes)})},
 Base64Helper:class{encodeToStringSync(b){return Buffer.from(b).toString('base64');}decodeSync(s){return new Uint8Array(Buffer.from(s,'base64'));}}};
function load(file,names,env={}) {
 const source=fs.readFileSync(new URL(file,root),'utf8').replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm,'').replace(/\bexport /g,'');
 const ctx=vm.createContext({console,setTimeout,clearTimeout,util,...env});
 vm.runInContext(stripTypeScriptTypes(source,{mode:'strip'})+'\nObject.assign(globalThis,{'+names.join(',')+'});',ctx);
 return Object.fromEntries(names.map(name=>[name,ctx[name]]));
}
const wire=load('mail/MailWire.ets',['mailQuote','mailAddress','mailboxWire','mailboxDisplay','mailHeaders','mimeText','composeMail','mailBase64','mailDecode']);
assert.throws(()=>wire.mailQuote('bad\r\nUID STORE 1 +FLAGS (\\Deleted)'));
assert.throws(()=>wire.mailAddress('attacker@example.com\r\nBcc: victim@example.com'));
for(const folder of ['INBOX','草稿箱','项目 & 家庭','😀归档']) assert.equal(wire.mailboxDisplay(wire.mailboxWire(folder)),folder);
const subject='中文标题和emoji😀'.repeat(20);
const composed=wire.composeMail('from@example.com',['to@example.com'],[] ,subject,'正文\n.second line');
assert.equal(wire.mailHeaders(composed).subject,subject);
assert.equal(wire.mimeText(composed),'正文\n.second line');
assert.equal(composed.includes('Bcc:'),false);
assert.ok(composed.split('\r\n').every(line=>line.length<1000));
assert.equal(wire.mimeText('Content-Type: multipart/alternative; boundary="x"\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nplain\r\n--x\r\nContent-Type: text/html\r\n\r\n<b>html</b>\r\n--x--'),'plain');

const writes=[]; let lines=[],literals=[];
class FixtureStream {
 async connect(){} async line(){assert.ok(lines.length,'unexpected fixture read');return lines.shift();}
 async literal(size){const value=literals.shift();assert.equal(value.byteLength,size);return value;}
 async send(text,authentication=false){writes.push({text,authentication});}
 close(){}
}
const imap=load('mail/IMAPClient.ets',['IMAPClient'],{...wire,MailTransport:FixtureStream});
const client=new imap.IMAPClient();
lines=['* OK ready','L1 OK login','* CAPABILITY IMAP4rev1 MOVE','L2 OK capabilities'];
await client.open({imapHost:'imap.example.com',imapPort:993,auth:'password',username:'me@example.com'},'secret');
assert.equal(writes[0].text,'L1 LOGIN "me@example.com" "secret"\r\n');assert.equal(writes[0].authentication,true);
const raw='Subject: fixture\r\nFrom: a@example.com\r\n\r\nbody';
lines=['* 1 FETCH (UID 7 FLAGS (\\Seen) RFC822.SIZE 200 BODY[] {'+Buffer.byteLength(raw)+'}',')','L3 OK done'];
literals=[new Uint8Array(Buffer.from(raw))];
const fetched=await client.fetch(7);
assert.equal(fetched.text,raw);assert.equal(fetched.size,200);assert.deepEqual(Array.from(fetched.flags),['\\Seen']);
await assert.rejects(client.update('1\r\nDELETE INBOX','mark_read'));
lines=['L4 OK moved'];await client.update('7','move','草稿箱');
assert.ok(writes.at(-1).text.includes('UID MOVE 7 "&'));

const smtpWrites=[];let smtpLines=[];let upgraded=false;
class SMTPFixture {
 async connect(_host,_port,implicit){this.secure=implicit;}
 async line(){assert.ok(smtpLines.length);return smtpLines.shift();}
 async send(text,authentication=false){if(authentication)assert.equal(this.secure,true);smtpWrites.push(text);}
 async upgradeTLS(){upgraded=true;this.secure=true;}
 close(){}
}
const smtp=load('mail/SMTPClient.ets',['SMTPClient'],{...wire,MailTransport:SMTPFixture});
smtpLines=['220 ready','250-test','250 STARTTLS','220 upgrade','250-AUTH PLAIN','250 ok','235 auth','250 from','250 rcpt','354 data','250 queued'];
await new smtp.SMTPClient().send({smtpHost:'smtp.example.com',smtpPort:587,smtpStartTLS:true,auth:'password',username:'me@example.com',email:'me@example.com'},'secret',['to@example.com'],'From: me@example.com\r\n\r\n.leading');
assert.equal(upgraded,true);assert.ok(smtpWrites.some(text=>text.includes('\r\n..leading')));
assert.ok(smtpWrites.indexOf('STARTTLS\r\n')<smtpWrites.findIndex(text=>text.startsWith('AUTH ')));
smtpLines=['220 ready','250 no TLS'];
await assert.rejects(new smtp.SMTPClient().send({smtpHost:'smtp.example.com',smtpPort:587,smtpStartTLS:true,email:'me@example.com'},'secret',['to@example.com'],'body'));
// EOF after DATA is uncertain delivery and must not be treated as safe-to-resend.
smtpLines=['220 ready','250 AUTH PLAIN','235 auth','250 from','250 rcpt','354 data'];
await assert.rejects(new smtp.SMTPClient().send({smtpHost:'smtp.example.com',smtpPort:465,smtpStartTLS:false,auth:'password',username:'me@example.com',email:'me@example.com'},'secret',['to@example.com'],'body'),/结果待确认/);
console.log('MAIL_PROTOCOL_OK production MIME/UTF7/injection guards, IMAP literal/flags/move, SMTP STARTTLS/auth/dot-stuff/uncertain delivery');

// Verify actual TLS adapter options and cancellation without replacing production protocol decisions.
const sockets=[];const tlsOptions=[];
class NativeSocket {
 handlers=new Map(); async bind(){} on(name,callback){this.handlers.set(name,callback);} off(name){this.handlers.delete(name);}
 async connect(options){tlsOptions.push(options);} async send(){} async close(){this.closed=true;}
 emit(text){this.handlers.get('message')?.({message:Buffer.from(text).buffer.slice(Buffer.from(text).byteOffset,Buffer.from(text).byteOffset+Buffer.byteLength(text))});}
}
const socket={Protocol:{TLSv12:'TLSv1.2',TLSv13:'TLSv1.3'},constructTLSSocketInstance:tcp=>{const stream=new NativeSocket();stream.parent=tcp;sockets.push(stream);return stream;},
 constructTCPSocketInstance:()=>{const stream=new NativeSocket();sockets.push(stream);return stream;}};
const transport=load('mail/MailTransport.ets',['MailTransport'],{socket});
const native=new transport.MailTransport();await native.connect('imap.example.com',993);
assert.equal(tlsOptions[0].address.address,'imap.example.com','original hostname retained for native SNI and hostname verification');
assert.equal(tlsOptions[0].skipRemoteValidation,false);
assert.equal(tlsOptions[0].secureOptions.ca,undefined,'native system CA store used');
const pending=native.line();
const fragment=Buffer.from('hello\r\n');
sockets.at(-1).handlers.get('message')({message:fragment.buffer.slice(fragment.byteOffset,fragment.byteOffset+fragment.byteLength)});
assert.equal(await pending,'hello');
const cancelled=native.line();native.close();await assert.rejects(cancelled,/取消/);
const plain=new transport.MailTransport();await plain.connect('smtp.example.com',587,false);
await assert.rejects(plain.send('AUTH PLAIN secret',true),/安全连接未建立/);
await plain.upgradeTLS('smtp.example.com',587);await plain.send('AUTH PLAIN secret',true);plain.close();

const accountModule=load('mail/MailAccountStore.ets',['MailAccount','validateMailAccount'],{AtomicTextFile:class{}});
const account=new accountModule.MailAccount();Object.assign(account,{id:'account-a',email:'me@example.com',username:'me@example.com',imapHost:'imap.example.com',smtpHost:'smtp.example.com',secretRef:'generation-a'});
accountModule.validateMailAccount(account);
assert.throws(()=>accountModule.validateMailAccount({...account,smtpHost:'evil.example/path'}));
assert.throws(()=>accountModule.validateMailAccount({...account,imapPort:0}));
let approvalResolve, approvals=0, opened=0;
const accounts={rows:[account],load:async()=>{},resolve:async()=>account};
const mailTools=load('local/MailTools.ets',['MailTools','mailToolSchemas'],{
 mailAccountStore:accounts,MailAccountStore:{binding:row=>JSON.stringify([row.id,row.email,row.smtpHost])},
 promptAction:{showDialog:async()=>{approvals++;return await new Promise(resolve=>approvalResolve=resolve);}},
 MailService:{open:async()=>{opened++;return {close(){},select:async()=>{},update:async()=>{throw new Error('cancelled task wrote mail');}};}},
});
await assert.rejects(mailTools.MailTools.run({},'mail_send',JSON.stringify({account:'account-a',to:'to@example.com',body:'hello'}),'owner',true),/本机会话/);
assert.equal(approvals,0,'unattended send never prompts or opens SMTP');
const write=mailTools.MailTools.run({},'mail_update',JSON.stringify({account:'account-a',uids:'7',action:'mark_read'}),'owner',false);
await new Promise(resolve=>setImmediate(resolve));mailTools.MailTools.cancel('owner');approvalResolve({index:1});
await assert.rejects(write,/取消/);assert.equal(opened,0,'cancelled approval cannot reach mailbox');
const schemas=JSON.parse(mailTools.mailToolSchemas());assert.equal(schemas.length,8);
assert.ok(schemas.find(schema=>schema.function.name==='mail_send').function.parameters.required.includes('body'));
console.log('MAIL_BOUNDARIES_OK production TLS/SNI/CA settings, socket cancellation, unattended-send denial, owner-cancelled approval and schema');

// Credential generations remain paired with their authorized destinations across stale writers.
const disk=new Map(),secrets=new Map();let generation=0,delayStage=false,releaseStage;
class AtomicAdapter {
 snapshots=new Map();read(path){const value=disk.get(path)||'';this.snapshots.set(path,value);return value;}
 write(path,value){assert.equal(disk.get(path)||'',this.snapshots.get(path)||'','stale metadata rejected');disk.set(path,value);this.snapshots.set(path,value);}
}
const bound={stage:async(binding,value)=>{const ref='generation-'+(++generation);secrets.set(ref,{binding,value});if(delayStage){delayStage=false;await new Promise(resolve=>releaseStage=resolve);}return ref;},
 read:async(ref,binding)=>{const value=secrets.get(ref);return value?.binding===binding?value.value:'';},retire:async ref=>{secrets.delete(ref);}};
const stores=load('mail/MailAccountStore.ets',['MailAccountStore'],{AtomicTextFile:AtomicAdapter,BoundSecret:bound});
const firstStore=new stores.MailAccountStore(),secondStore=new stores.MailAccountStore();
const context={filesDir:'/private-app'};
await firstStore.save(context,account,'old-secret');
const edited={...account,smtpHost:'smtp-a.example.com'};
delayStage=true;const pendingSave=firstStore.save(context,edited,'secret-a');pendingSave.catch(()=>{});
await new Promise(resolve=>setImmediate(resolve));
await secondStore.save(context,{...account,smtpHost:'smtp-b.example.com'},'secret-b');
releaseStage();await assert.rejects(pendingSave,/stale metadata/);
const fresh=new stores.MailAccountStore();const winning=await fresh.resolve(context,'account-a');
assert.equal(winning.smtpHost,'smtp-b.example.com');assert.equal(await fresh.credential(winning),'secret-b');
await assert.rejects(fresh.save(context,{...winning,smtpHost:'unapproved.example.com'},''),/重新输入凭据/);
console.log('MAIL_GENERATIONS_OK actual account store mutation, stale-writer rejection and destination/credential binding');
