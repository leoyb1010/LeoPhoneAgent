import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
const root=new URL('../app/entry/src/main/ets/local/',import.meta.url);
const schemas=fs.readFileSync(new URL('ExtraToolSchemas.ets',root),'utf8').replace(/\bexport\s+/g,'');
const source=fs.readFileSync(new URL('PlatformTools.ets',root),'utf8').replace(/^import[^\n]*\n/gm,'').replace(/\bexport\s+/g,'');
let foreground=true,approved=false, permissions=0,creates=0;
const context=vm.createContext({console,AppStorage:{get:()=>foreground},WRITE_GRANT_MARK:'__GRANT__',
  toolArg:(raw,key)=>`${JSON.parse(raw)[key]??''}`, SensitiveToolGate:{consumeWriteGrant:owner=>approved&&owner==='session'},
  abilityAccessCtrl:{createAtManager:()=>({requestPermissionsFromUser:async(_ctx,perms)=>{permissions++;return{authResults:perms.map(()=>0)};}})},
  calendarManager:{getCalendarManager:()=>({getCalendar:async()=>({addEvent:async()=>{creates++;return 22;},getEvents:async()=>[]})}),EventType:{NORMAL:0},EventFilter:{filterByTime:()=>({})}},
});
vm.runInContext(stripTypeScriptTypes(schemas+'\n'+source,{mode:'strip'})+'\nglobalThis.Tools=PlatformTools;',context);
const tools=context.Tools,ui={startAbility(){}};
const args=JSON.stringify({title:'test',start:'2026-11-09T10:00:00+08:00',end:'2026-11-09T11:00:00+08:00'});
assert.match(await tools.run(ui,'calendar_create',args,'session',true),/前台/);
assert.match(await tools.run(ui,'calendar_create',args,'',false),/前台/);
assert.equal(permissions,0);
assert.match(await tools.run(ui,'calendar_create',args,'session',false),/__GRANT__/);
assert.equal(permissions,0);
approved=true;
assert.match(await tools.run(ui,'calendar_create',args,'session',false),/22/);
assert.equal(creates,1);
foreground=false;
assert.match(await tools.run(ui,'calendar_create',args,'session',false),/前台/);
assert.equal(creates,1);
foreground=true;
await assert.rejects(tools.run(ui,'calendar_create','{"title":"bad","start":"tomorrow","end":"later"}','session',false),/时间/);
assert.equal(creates,1);
vm.runInContext('globalThis.schemas=extraToolSchemas;',context);
const parsed=JSON.parse(context.schemas());
assert.equal(parsed.length,29);
assert.equal(new Set(parsed.map(t=>t.function.name)).size,29);
assert.ok(parsed.some(t=>t.function.name==='shell_execute'));
for(const tool of parsed){assert.equal(tool.type,'function');assert.equal(tool.function.parameters.type,'object');}
console.log('BRAIN_PLATFORM_OK actual ETS foreground/unattended/owner gates, native write admission and all 29 schemas');
