#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const [command, rootArg] = process.argv.slice(2);
assert.ok(['apply','verify'].includes(command) && rootArg,'Usage: apply-native-cli-auth.mjs <apply|verify> <physical pinned upstream root>');
const home=fileURLToPath(new URL('..',import.meta.url));
const root=path.resolve(rootArg);
assert.equal(fs.realpathSync(root),root,'use physical upstream root');
const lock=JSON.parse(fs.readFileSync(path.join(home,'upstream.lock.json')));
assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),lock.commit,'unknown upstream commit');
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const patchFiles=['backend-api.patch.json','backend-integration.patch.json'];
const patches=patchFiles.flatMap(name=>JSON.parse(fs.readFileSync(path.join(home,'native',name))));
const targets=new Map();
for (const patch of patches) {
 assert.ok(/^(server\/src\/|packages\/shared\/src\/)/.test(patch.file) && !patch.file.split('/').includes('..'),'closed backend patch scope');
 if (!targets.has(patch.file))targets.set(patch.file,execFileSync('git',['show',`HEAD:${patch.file}`],{cwd:root,encoding:'utf8'}));
 const input=targets.get(patch.file);assert.equal(input.split(patch.from).length-1,patch.expected ?? 1,`context mismatch: ${patch.file}`);
 targets.set(patch.file,input.split(patch.from).join(patch.to));
}
const added=[];
function modules(directory,relative='') {
 for (const entry of fs.readdirSync(directory,{withFileTypes:true})) {
  const rel=path.join(relative,entry.name);const p=path.join(directory,entry.name);
  assert.ok(!entry.isSymbolicLink(),'native modules must be regular');
  if(entry.isDirectory())modules(p,rel);
  else if(entry.isFile() && entry.name.endsWith('.ts')) {
   const destination=rel.startsWith('services/')||rel.startsWith('__tests__/')?rel:path.join('services',rel);
   const target='server/src/'+destination;assert.ok(!targets.has(target),'duplicate target');
   targets.set(target,fs.readFileSync(p,'utf8'));added.push(target);
  }
 }
}
modules(path.join(home,'native/server'));
const state={commit:lock.commit,files:{}};
const statePath=path.join(root,'.leophone-native-cli-auth.json');
const previous=fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath)):null;
if(previous)assert.equal(previous.commit,lock.commit,'previous overlay commit mismatch');
// Validate every destination before any write, so unknown operator changes are preserved.
for (const [relative,output] of targets) {
 const target=path.join(root,relative);
 const nearest=fs.existsSync(path.dirname(target))?path.dirname(target):path.dirname(path.dirname(target));
 assert.equal(fs.realpathSync(nearest),nearest,'refuse symlinked parent');
 if (fs.existsSync(target)) {
  assert.equal(fs.realpathSync(target),target,'refuse symlinked target');
  const current=fs.readFileSync(target,'utf8');
  const original=added.includes(relative)?null:execFileSync('git',['show',`HEAD:${relative}`],{cwd:root,encoding:'utf8'});
  assert.ok(current===output||current===original||previous?.files?.[relative]===hash(current),`unknown edits: ${relative}`);
 }
 if(command==='verify')assert.equal(fs.readFileSync(target,'utf8'),output,`overlay differs: ${relative}`);
 state.files[relative]=hash(output);
}
if(command==='apply') {
 for(const [relative,output] of targets) {
  const target=path.join(root,relative);fs.mkdirSync(path.dirname(target),{recursive:true});
  const temp=target+`.native-${process.pid}.tmp`;
  try {fs.writeFileSync(temp,output,{flag:'wx'});fs.renameSync(temp,target);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
 }
 fs.writeFileSync(path.join(root,'.leophone-native-cli-auth.json'),JSON.stringify(state,null,2)+'\n');
} else assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'.leophone-native-cli-auth.json'))),state,'overlay state mismatch');
console.log(JSON.stringify({command,root,commit:state.commit,files:Object.keys(state.files).length}));
