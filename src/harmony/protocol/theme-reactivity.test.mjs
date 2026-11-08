import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
const root=new URL('../app/entry/src/main/ets/',import.meta.url);
const source=file=>fs.readFileSync(new URL(file,root),'utf8');
function load(file,names,globals={}) {
  const code=source(file).replace(/^import[\s\S]*?;\s*/gm,'').replace(/\bexport\s+/g,'');
  return vm.runInNewContext(stripTypeScriptTypes(code)+`\n({${names}})`,globals);
}
const {Tokens}=load('theme/Tokens.ets','Tokens');
const Mode={COLOR_MODE_LIGHT:1,COLOR_MODE_DARK:0,COLOR_MODE_NOT_SET:-1};
let physical=0,readFails=false,writeFails=false,nativeFails=false;
const storage=new Map(),disk=new Map(),calls=[],revisions=[];
const listeners=new Set();let activeRender=null;
const {ThemeStore}=load('store/ThemeStore.ets','ThemeStore',{
  Tokens,ConfigurationConstant:{ColorMode:Mode},Date:{now:()=>7},
  resourceManager:{ColorMode:{DARK:0,LIGHT:1},getSystemResourceManager:()=>({getConfigurationSync:()=>{if(readFails)throw new Error('system config');return {colorMode:physical};}})},
  fileIo:{accessSync:p=>disk.has(p),readTextSync:p=>disk.get(p)},
  atomicWriteText:(p,data)=>{if(writeFails)throw new Error('disk write');disk.set(p,data);},
  taskStatus:{setCardsEnabled(){}},
  AppStorage:{get:key=>storage.get(key),setOrCreate:(key,value)=>{
    storage.set(key,value);
    if(key==='themeTick') { revisions.push(value); for(const render of listeners)render(); }
  }}
});
const store=new ThemeStore(),context={filesDir:'/test-app/files'};
const bars=[];
const win={setWindowSystemBarProperties:async props=>{bars.push(props);},setWindowKeepScreenOn:async()=>{}};
const app={setColorMode:target=>{
  calls.push({target,dark:Tokens.dark});
  if(nativeFails)throw new Error('native mode');
  // Deliberately deliver synchronously: this must not enter a reconfiguration loop.
  store.onConfigurationUpdate(target===Mode.COLOR_MODE_NOT_SET?physical:target);
}};
await store.load(context);
assert.equal(calls.length,0,'load/save before a ready window must never call the native override');
assert.equal(Tokens.dark,true);
store.mode='light';await store.save(context);assert.equal(calls.length,0);assert.equal(Tokens.dark,false);
store.attachWindow(win,app);assert.equal(calls.length,1);assert.equal(calls[0].target,Mode.COLOR_MODE_LIGHT);assert.equal(calls[0].dark,false);
assert.equal(store.systemDark,true,'fixed-mode callback must not replace the actual system preference');
store.apply();store.attachWindow(win,app);assert.equal(calls.length,1,'same native override is idempotent');

// Execute the current paint expressions, with dependency tracking on the StorageProp getter.
// This proves the JS bridge/dependency, not ArkUI native repaint or pixels.
function paintExpression(file,needle) {
  const code=source(file),start=code.indexOf(needle);assert.ok(start>=0,file+': '+needle);
  const open=code.indexOf('(',start);let depth=1,i=open+1;
  for(;i<code.length;i++){if(code[i]==='(')depth++;else if(code[i]===')'&&--depth===0)break;}
  return code.slice(open+1,i);
}
const owner={color:'',draft:'retain draft',offset:712};
for(const key of ['tick','themeTick'])Object.defineProperty(owner,key,{get(){if(activeRender)listeners.add(activeRender);return storage.get('themeTick');}});
const paints={};
const views=[
  ['background','pages/AppearancePage.ets','.backgroundColor(Tokens.reactive(this.tick, Tokens.grouped))'],
  ['longText','chat/LongAnswer.ets','.fontColor(Tokens.reactive(this.themeTick, Tokens.text))'],
  ['glyph','theme/Symbols.ets','.fontColor(Tokens.reactive(this.themeTick, [this.color || Tokens.text]))'],
  ['markdown','theme/Markdown.ets','.fontColor(Tokens.reactive(this.themeTick, color()))']
];
for(const [name,file,needle] of views) {
  const read=new Function('Tokens','color','return '+paintExpression(file,needle));
  const render=()=>{activeRender=render;paints[name]=read.call(owner,Tokens,()=>owner.color||Tokens.text);activeRender=null;};render();
}
assert.equal(listeners.size,4);
let previousTick=storage.get('themeTick');
for(const mode of ['dark','light','dark','light']) {
  store.mode=mode;await store.save(context);
  assert.equal(JSON.parse(disk.get('/test-app/files/appearance.json')).mode,mode);
  assert.ok(storage.get('themeTick')>previousTick);previousTick=storage.get('themeTick');
  assert.equal(Tokens.dark,mode==='dark');
  assert.equal(paints.background,Tokens.grouped);assert.equal(paints.longText,Tokens.text);
  assert.equal(paints.markdown,Tokens.text);assert.equal(paints.glyph[0],Tokens.text);
  assert.equal(calls.at(-1).dark,mode==='dark','palette is updated before the SDK call');
}
assert.equal(new Set(revisions).size,revisions.length,'clock collisions cannot suppress a theme revision');
assert.equal(owner.draft,'retain draft');assert.equal(owner.offset,712);
owner.color='custom-color';store.apply();assert.equal(paints.markdown,'custom-color');assert.equal(paints.glyph[0],'custom-color');owner.color='';

store.mode='dark';await store.save(context);physical=1;
store.onConfigurationUpdate(Mode.COLOR_MODE_DARK);
assert.equal(Tokens.dark,true);
store.mode='system';await store.save(context);
assert.equal(calls.at(-1).target,Mode.COLOR_MODE_NOT_SET,'follow-system releases the override, not hard-codes the cached color');
assert.equal(calls.at(-1).dark,false,'actual system configuration is read before releasing the override');
assert.equal(Tokens.dark,false);
const systemCalls=calls.length;physical=0;store.onConfigurationUpdate(Mode.COLOR_MODE_DARK);
assert.equal(Tokens.dark,true);assert.equal(calls.length,systemCalls,'configuration callback never calls the setter');
store.onConfigurationUpdate(undefined);assert.equal(Tokens.dark,true);
store.detachWindow({});store.apply();assert.equal(calls.length,systemCalls,'stale window detach cannot remove the current owner');
store.detachWindow(win);store.mode='light';await store.save(context);assert.equal(calls.length,systemCalls,'detached windows cannot reconfigure the application');
store.attachWindow(win,app);assert.equal(calls.length,systemCalls+1);
nativeFails=true;store.mode='dark';await store.save(context);assert.match(store.nativeError,/未应用/);
const firstFailure=calls.length;store.mode='light';await store.save(context);assert.equal(calls.length,firstFailure);assert.equal(store.nativeError,'','returning to the already-applied mode clears the failed override notice');
store.mode='dark';await store.save(context);assert.match(store.nativeError,/未应用/);
const failedCalls=calls.length;nativeFails=false;store.apply();assert.equal(calls.length,failedCalls+1);assert.equal(store.nativeError,'');
store.apply();assert.equal(calls.length,failedCalls+1,'a successful retry is not repeated');
writeFails=true;store.mode='light';const beforeFailedWrite=calls.length;
await assert.rejects(store.save(context),/disk write/);assert.equal(calls.length,beforeFailedWrite);assert.equal(Tokens.dark,true);
writeFails=false;await store.reload(context);assert.equal(store.mode,'dark');assert.equal(Tokens.dark,true);
readFails=true;physical=1;store.mode='system';await store.save(context);
assert.equal(Tokens.dark,false,'native follow-system callback reconciles a failed system-resource read');
assert.ok(bars.length>0);
console.log('THEME_STORE_OK real store/palette, persistence, monotonic revisions, pre-setter colors, follow-system, synchronous callback/idempotence, detach and failures');

// Callback Builder contracts remain live without replacing component identity.
const appearance=source('pages/AppearancePage.ets');
assert.match(appearance,/choiceContent\(value: string, current: \(\) => string/);
const selectedExpression=/if \((current\(\) === value)\)/.exec(appearance);assert.ok(selectedExpression);
const selected=new Function('current','value','return '+selectedExpression[1]);
const choiceOwner={mode:'dark'};const liveCurrent=()=>choiceOwner.mode;
for(const mode of ['light','dark','system','light']) {choiceOwner.mode=mode;assert.equal(selected(liveCurrent,mode),true);assert.equal(selected(liveCurrent,mode==='dark'?'light':'dark'),false);}
for(const value of ['system','light','dark'])assert.ok(appearance.includes(`this.choice('${value}', () => this.mode`));
assert.match(appearance,/toggle\(title: string, on: \(\) => boolean/);assert.ok(appearance.includes('isOn: on()'));
const markdown=source('theme/Markdown.ets');
assert.match(markdown,/inline\(text: string, size: number, weight: FontWeight, color: \(\) => string/);
assert.ok(markdown.includes('color: Tokens.reactive(this.themeTick, this.color), textSize:'),'an omitted Markdown color stays omitted until paint time');
assert.equal((markdown.match(/@Prop selectable: boolean = true/g)||[]).length,2,'direct selection remains the default outside chat');
assert.ok(source('chat/LongAnswer.ets').includes('MarkdownText({ text: this.text, selectable: false })'),'chat preserves explicit choose-text policy');
for(const file of ['theme/Symbols.ets','theme/Widgets.ets'])assert.doesNotMatch(source(file),/@Prop (?:color|dot): string = Tokens\./);
console.log('THEME_BINDING_OK current Builder callbacks, default-color fallbacks and unchanged selection contract (not native rendering)');

// Execute the real UIAbility's loadWindow method with only its lifecycle dependencies stubbed.
const entry=source('entryability/EntryAbility.ets');
const method=/private loadWindow\(windowStage: window.WindowStage, generation: number\): void \{([\s\S]*?)\n  \}/.exec(entry);assert.ok(method);
let callback,attached=0;
const loadWindow=vm.runInNewContext(stripTypeScriptTypes('function loadWindow(windowStage, generation) {'+method[1]+'\n}\nloadWindow'),{
  themeStore:{attachWindow:(window,application)=>{assert.equal(window,readyWindow);assert.equal(application,app);attached++;}},
  KeyboardAvoidMode:{RESIZE:1},AppStorage:{setOrCreate(){}},console:{error(){}}
});
const readyWindow={getUIContext:()=>({setKeyboardAvoidMode(){}}),on(){}};
const stage={loadContent:(name,cb)=>{assert.equal(name,'pages/HomePage');callback=cb;},getMainWindow:async()=>readyWindow};
const ability={recoveryFailed:false,destroyed:false,windowGeneration:1,context:{getApplicationContext:()=>app},publishWindowFrame(){}};
loadWindow.call(ability,stage,1);assert.equal(attached,0);
callback({code:0});await Promise.resolve();assert.equal(attached,1,'attach only after successful content load');
loadWindow.call(ability,stage,1);ability.windowGeneration=2;callback({code:0});await Promise.resolve();assert.equal(attached,1,'stale load cannot own the theme');
loadWindow.call(ability,stage,2);callback({code:1});await Promise.resolve();assert.equal(attached,1,'failed content load cannot call setColorMode');
assert.doesNotMatch(entry,/themeStore\.systemDark = newConfig\.colorMode/);
console.log('THEME_LIFECYCLE_OK production successful/stale/failed content-load gates');
