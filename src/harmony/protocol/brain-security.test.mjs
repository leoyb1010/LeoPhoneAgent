import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {randomUUID} from 'node:crypto';
const filename = new URL('../app/entry/src/main/ets/brain/BrainAPI.ets', import.meta.url);
const source = fs.readFileSync(filename, 'utf8').replace(/^import[^\n]*\n/gm, '').replace(/\bexport\s+/g, '');
let stored = '', pending;
let replies = [];
const calls = [];
let delayed = false;
const http = {
  RequestMethod: {GET: 'GET', POST: 'POST'}, HttpDataType: {STRING: 0, ARRAY_BUFFER: 1},
  createHttp() { return {destroy() {}, async request(url, options) {
    calls.push({url, options});
    if (replies.length) { const reply = replies.shift(); if (reply instanceof Error) throw reply; return reply; }
    if (delayed) return new Promise(resolve => pending = resolve);
    return {responseCode: 200, result: url.endsWith('/session') ? '{"token":"page-token"}' : '{"items":[]}'};
  }}; },
};
const context = vm.createContext({http, SecretStore: {read: async () => stored, write: async (_key, value) => stored = value},
  util: {generateRandomUUID: () => randomUUID()}, console, Date, Uint8Array});
vm.runInContext(stripTypeScriptTypes(source, {mode:'strip'}) + '\nglobalThis.API=BrainAPI;', context);
const api = context.API;
await assert.rejects(api.connect('http://archive.example', 'a'.repeat(32), '', ''), /HTTPS/);
await assert.rejects(api.connect('https://archive.example@evil.example', 'a'.repeat(32), '', ''), /HTTPS/);
await assert.rejects(api.connect('https://archive.example/path', 'a'.repeat(32), '', ''), /HTTPS/);
await api.connect('https://archive.example', 'a'.repeat(32), 'id-a', 'secret-a');
await api.get('/search', '?q=test');
assert.equal(calls.at(-1).url, 'https://archive.example/v1/app/api/search?q=test');
assert.equal(calls.at(-1).options.maxRedirects, 0);
assert.equal(calls.at(-1).options.header.Authorization, 'Bearer ' + 'a'.repeat(32));
assert.equal(calls.at(-1).options.header['CF-Access-Client-Secret'], 'secret-a');
await assert.rejects(api.bytes('/media/1/preview'), /解锁/);
await assert.rejects(api.post('/shares', {}), /解锁/);
api.unlockedUntil = Date.now() + 60000;
await api.post('/shares', {file_ids:['one']});
assert.equal(calls.at(-1).options.header['X-Leo-Token'], 'page-token');
delayed = true;
const stale = api.get('/search', '?q=old');
await api.connect('https://new.example', 'b'.repeat(32), '', '');
pending({responseCode:200, result:'{"items":[{"id":"old"}]}'});
await assert.rejects(stale, /连接已改变/);
delayed = false;
assert.equal(api.unlockedUntil, 0);
await api.get('/search');
assert.equal(calls.at(-1).url, 'https://new.example/v1/app/api/search');
assert.equal(calls.at(-1).options.header['CF-Access-Client-Secret'], undefined);
assert.equal(calls.at(-1).options.header['X-Leo-Token'], undefined);
const generation = api.generation();
await api.load();
assert.equal(api.generation(), generation);
console.log('BRAIN_SECURITY_OK actual ETS credential isolation, unlock, redirects, stale responses');

// A hash or any other awaited preparation must retain the original connection + unlock epoch.
api.unlockedUntil = Date.now() + 60000;
const uploadLease = api.lease();
const beforeSwitch = calls.length;
await api.connect('https://third.example', 'c'.repeat(32), '', '');
api.unlockedUntil = Date.now() + 60000;
await assert.rejects(api.postBytes('/upload/one?offset=0',new ArrayBuffer(3),'application/octet-stream',{},uploadLease), /改变/);
assert.equal(calls.length,beforeSwitch);
const beforeLockLease = api.lease();
api.invalidate();
api.unlockedUntil = Date.now() + 60000;
await assert.rejects(api.postBytes('/upload/one?offset=0',new ArrayBuffer(3),'application/octet-stream',{},beforeLockLease), /改变/);
assert.equal(calls.length,beforeSwitch);
// Only an explicit expired-session 403 may replay a write, exactly once.
replies=[{responseCode:200,result:'{"token":"old-page"}'},{responseCode:403,result:'{"error":"网页会话已过期"}'},
 {responseCode:200,result:'{"token":"new-page"}'},{responseCode:200,result:'{"ok":true}'}];
const rotationStart=calls.length;
await api.post('/shares',{file_ids:['one']});
assert.equal(calls.length-rotationStart,4);
assert.equal(calls.at(-1).options.header['X-Leo-Token'],'new-page');
api.invalidate();api.unlockedUntil=Date.now()+60000;
replies=[{responseCode:200,result:'{"token":"current-page"}'},{responseCode:403,result:'{"error":"权限不足"}'}];
const forbiddenStart=calls.length;
await assert.rejects(api.post('/shares',{}),/403/);
assert.equal(calls.length-forbiddenStart,2);
replies=[{responseCode:500,result:'{"error":"unknown outcome"}'}];
const unknownStart=calls.length;
await assert.rejects(api.post('/shares',{}),/500/);
assert.equal(calls.length-unknownStart,1);
replies=[new Error('network interrupted after send')];
const networkStart=calls.length;
await assert.rejects(api.post('/shares',{}),/network/);
assert.equal(calls.length-networkStart,1);
console.log('BRAIN_WRITE_LEASE_OK hash-bound generation/epoch, exact session rotation, no unknown-outcome replay');
