import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
const root = new URL('../app/entry/src/main/ets/', import.meta.url);
function load(file, symbols, globals = {}) {
  const source = fs.readFileSync(new URL(file, root), 'utf8').replace(/^import[\s\S]*?;\s*/gm, '').replace(/\bexport\s+/g, '');
  return vm.runInNewContext(stripTypeScriptTypes(source) + `\n({${symbols}})`, globals);
}
const { LayoutState, layoutSize, resolveLayout, toggleInspector } = load('layout/LayoutPolicy.ets', 'LayoutState,layoutSize,resolveLayout,toggleInspector');
for (const [width, expected] of [[0,'sm'],[599,'sm'],[600,'md'],[839.9,'md'],[840,'lg'],[1200,'lg'],[NaN,'sm']]) assert.equal(layoutSize(width), expected);
let state = resolveLayout(new LayoutState(), 1000, 2000);
assert.equal(state.inspector, true);
state = toggleInspector(state, 2100);
assert.equal(resolveLayout(state, 1100, 2200).inspector, false);
assert.equal(resolveLayout(state, 1100, 4000).inspector, false, 'same breakpoint must not undo a manual close');
for (let i=0; i<20; i++) {
  state = toggleInspector(state, 5000+i);
  assert.equal(resolveLayout(state, 1100, 5100+i).inspector, state.inspector);
}
state = resolveLayout(state, 500, 8000); assert.equal(state.inspector, false);
state = resolveLayout(state, 900, 10000); assert.equal(state.inspector, true);
const storage = new Map();
class Stack {
  rows=[];
  pushPathByName(name,param) { this.rows.push({name,param}); }
  replacePathByName(name,param) { this.rows.pop(); this.rows.push({name,param}); }
  pop() { return this.rows.pop(); }
  size() { return this.rows.length; }
  getAllPathName() { return this.rows.map(row => row.name); }
  getParamByIndex(index) { return this.rows[index]?.param; }
}
const { AppNavigation } = load('navigation/AppNavigation.ets', 'AppNavigation', { NavPathStack: Stack, AppStorage: {get:k=>storage.get(k),setOrCreate:(k,v)=>storage.set(k,v)} });
await assert.rejects(AppNavigation.pushUrl({url:'pages/SettingsPage'}), /尚未就绪/);
AppNavigation.ready=true;
assert.equal(AppNavigation.getState().name, 'HomePage');
const params={scanId:'scan-test'};
await AppNavigation.pushUrl({url:'pages/DocumentScanPage',params});
assert.equal(AppNavigation.getParams(),params);
assert.equal(AppNavigation.getState().name, 'DocumentScanPage');
await AppNavigation.pushUrl({url:'pages/SettingsPage'});
AppNavigation.back(); assert.equal(AppNavigation.getParams(), params);
await AppNavigation.replaceUrl({url:'pages/WorkspacePage',params:{path:'notes.md'}});
assert.equal(AppNavigation.stack.size(),1);
AppNavigation.back(); assert.equal(AppNavigation.stack.size(),0);
assert.equal(AppNavigation.getState().name, 'HomePage');
// Production conversation-owned view state is independent of layout policy and navigation.
const { ChatViewState } = load('local/ChatViewState.ets','ChatViewState',{AppStorage:{get:k=>storage.get(k),setOrCreate:(k,v)=>storage.set(k,v)}});
const draft=ChatViewState.get('session-layout-test'); draft.draft='未发送 👩‍💻'; draft.offset=1234; draft.nearBottom=false;
for(const w of [500,600,1000,500,850]) resolveLayout(state,w,11000);
assert.equal(ChatViewState.get('session-layout-test'),draft);
assert.equal(draft.draft,'未发送 👩‍💻'); assert.equal(draft.offset,1234); assert.equal(draft.nearBottom,false);
console.log('HARMONY_UX_POLICY_OK width thresholds, manual cooldown/20 toggles, native stack adapter, stored draft/offset (not UI rendering)');
// Navigation migration must never rewrite provider hosts or OAuth destinations.
const providerCatalog=fs.readFileSync(new URL('local/ProviderCatalog.ets',root),'utf8');
const browserOAuth=fs.readFileSync(new URL('local/BrowserOAuth.ets',root),'utf8');
assert.ok(providerCatalog.includes('https://openrouter.ai/api/v1'));
assert.ok(browserOAuth.includes('https://openrouter.ai/auth?') && browserOAuth.includes('https://openrouter.ai/api/v1/auth/keys'));
assert.ok(!providerCatalog.includes('AppNavigation') && !browserOAuth.includes('AppNavigation'));
