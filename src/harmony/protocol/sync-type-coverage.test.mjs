// Registry guard complements executable domain tests; it does not assert device/server acceptance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
const root=new URL('../app/entry/src/main/ets/',import.meta.url);
function load(file,names,env={}){const source=fs.readFileSync(new URL(file,root),'utf8').replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm,'').replace(/\bexport\s+/g,'');const c=vm.createContext({console,...env});vm.runInContext(stripTypeScriptTypes(source,{mode:'strip'})+`\nObject.assign(globalThis,{${names.join(',')}});`,c);return Object.fromEntries(names.map(n=>[n,c[n]]));}
const helpers={...load('sync/SessionReplica.ets',['SessionReplica']),...load('sync/ConfigReplica.ets',['ConfigReplica']),...load('sync/FileReplica.ets',['FileReplica']),...load('sync/MiscReplica.ets',['MiscReplica'])};
const {ReplicaSync}=load('sync/ReplicaSync.ets',['ReplicaSync'],helpers);
const swift=fs.readFileSync(new URL('../../ios/Agent/Sync/V2/SyncedTypes.swift',import.meta.url),'utf8');
const types=new Map();for(const match of swift.matchAll(/struct\s+(\w+):\s*Syncable\s*\{[\s\S]*?recordType:\s*"([^"]+)"/g))types.set(match[1],match[2]);
const registered=[...swift.matchAll(/r\.register\((\w+)\.self\)/g)].map(match=>types.get(match[1]));assert.equal(registered.length,19);
for(const type of registered)assert.equal(ReplicaSync.mapped(type),true,type+' needs a concrete registered domain handler');
console.log('HARMONY_SYNC_TYPE_COVERAGE_OK 19 current iOS registered record types routed to production domain handlers');
