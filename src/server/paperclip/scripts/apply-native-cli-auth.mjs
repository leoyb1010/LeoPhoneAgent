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
assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',maxBuffer:20_000_000}).trim(),lock.commit,'unknown upstream commit');
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const patchFiles=['backend-api.patch.json','backend-integration.patch.json','costs-realtime.patch.json','backend-db-runtime.patch.json','round1-runtime.patch.json','round1-boundaries.patch.json','visible-pagination.patch.json','round2-cli.patch.json','round2-resources.patch.json','round2-backup.patch.json','round3-hardening.patch.json','server-display-copy.patch.json','ui-test-assertions.patch.json'];
const patches=patchFiles.flatMap(name=>JSON.parse(fs.readFileSync(path.join(home,'native',name))).map(patch=>({...patch,source:name})));
const targets=new Map();
// 1.1.6：上游 UI 测试断言补丁只允许改 ui/src 下的 *.test.ts(x)，且只能来自独立的断言补丁文件；
// 后端白名单仅为本轮私密变量剔除与 Cursor 文档新增 3 个文件（adapter-utils 两个执行入口、cursor-local 文档）。
const uiTestAssertion=patch=>patch.source==='ui-test-assertions.patch.json'&&/^ui\/src\/[A-Za-z0-9_./-]+\.test\.tsx?$/.test(patch.file);
for (const patch of patches) {
 assert.ok(patch.source!=='ui-test-assertions.patch.json'||uiTestAssertion(patch),'ui test assertion scope');
 assert.ok((uiTestAssertion(patch) || /^(server\/src\/|packages\/shared\/src\/)/.test(patch.file) || ['packages/adapter-utils/src/server-utils.ts','packages/adapter-utils/src/remote-execution-env.ts','packages/adapters/cursor-local/src/index.ts','packages/db/src/backup-lib.ts','packages/adapters/hermes/src/server/test.ts','packages/adapters/opencode-local/src/server/test.ts','packages/db/src/embedded-postgres-native.ts','packages/adapters/hermes/src/server/execute.ts','packages/adapters/cursor-local/src/server/execute.ts','packages/adapters/cursor-local/src/server/test.ts','packages/adapters/cursor-local/src/server/test.test.ts','packages/adapters/cursor-local/src/server/execute.test.ts','packages/adapters/grok-local/src/server/execute.ts','packages/adapters/grok-local/src/server/test.ts','packages/adapters/grok-local/src/server/execute.test.ts','packages/adapters/grok-local/src/server/test.test.ts'].includes(patch.file)) && !patch.file.split('/').includes('..'),'closed backend patch scope');
 if (!targets.has(patch.file))targets.set(patch.file,execFileSync('git',['show',`HEAD:${patch.file}`],{cwd:root,encoding:'utf8',maxBuffer:20_000_000}));
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
// 1.1.6：adapter-utils 共享模块（私密变量剔除）及其测试，固定落在 packages/adapter-utils/src/。
for (const entry of fs.readdirSync(path.join(home,'native/adapter-utils'),{withFileTypes:true})) {
 assert.ok(entry.isFile() && !entry.isSymbolicLink() && /^[a-z0-9-]+(?:\.test)?\.ts$/.test(entry.name),'adapter-utils modules must be regular .ts files');
 const target='packages/adapter-utils/src/'+entry.name;assert.ok(!targets.has(target),'duplicate target');
 targets.set(target,fs.readFileSync(path.join(home,'native/adapter-utils',entry.name),'utf8'));added.push(target);
}
const fixtureModules = [
 ['native/db/round2-backup-faults.test.ts','packages/db/src/round2-backup-faults.test.ts'],
 ['tests/fixtures/round2-client-lease.ui.test.tsx','ui/src/lib/round2-client-lease.ui.test.tsx'],
 ['tests/fixtures/round2-cross-tab-session.ui.test.ts','ui/src/lib/round2-cross-tab-session.ui.test.ts'],
 ['tests/fixtures/round2-hermes-contract.test.ts','packages/adapters/hermes/src/server/round2-hermes-contract.test.ts'],
 ['tests/fixtures/round2-model-picker.ui.test.tsx','ui/src/components/task-chat/round2-model-picker.ui.test.tsx'],
 ['native/db/embedded-postgres-darwin.test.ts','packages/db/src/embedded-postgres-darwin.test.ts'],
 ['native/db/backup-collision.test.ts','packages/db/src/backup-collision.test.ts'],
 ['tests/fixtures/round1-hermes-probe.test.ts','packages/adapters/hermes/src/server/round1-hermes-probe.test.ts'],
 ['tests/fixtures/round1-hermes-route-consistency.test.ts','packages/adapters/hermes/src/server/round1-hermes-route-consistency.test.ts'],
 ['tests/fixtures/round1-opencode-model-rejection.test.ts','packages/adapters/opencode-local/src/server/round1-opencode-model-rejection.test.ts'],
 ['tests/fixtures/round1-draft-privacy.ui.test.tsx','ui/src/pages/round1-draft-privacy.ui.test.tsx'],
];
for (const [source, target] of fixtureModules) {
 const file=path.join(home,source);
 assert.ok(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink(),'fixture must be a regular file');
 assert.ok(!targets.has(target),'duplicate target');
 targets.set(target,fs.readFileSync(file,'utf8'));added.push(target);
}
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
  const original=added.includes(relative)?null:execFileSync('git',['show',`HEAD:${relative}`],{cwd:root,encoding:'utf8',maxBuffer:20_000_000});
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
