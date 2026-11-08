import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
const root = new URL('../app/entry/src/main/ets/', import.meta.url);
function load(file, symbols, globals = {}) {
  const source = fs.readFileSync(new URL(file, root),'utf8').replace(/^import[\s\S]*?;\s*/gm,'').replace(/\bexport\s+/g,'');
  return vm.runInNewContext(stripTypeScriptTypes(source)+`\n({${symbols}})`,globals);
}
const policy=load('chat/ChatUXPolicy.ets','FollowState,userScroll,incoming,textPages,previewBudget');
let follow=new policy.FollowState();
follow=policy.userScroll(follow,-900,false); assert.equal(follow.following,false); assert.equal(follow.distance,900);
follow=policy.incoming(follow,2); assert.equal(follow.unread,2); assert.equal(follow.following,false);
follow=policy.userScroll(follow,20,false); assert.equal(follow.following,false);
follow=policy.userScroll(follow,880,true); assert.equal(follow.following,true); assert.equal(follow.unread,0);
for(const text of ['', '短回答', '👩‍💻\né\n'.repeat(700), '```typescript\nconst secret = "redacted";\n```\n'.repeat(200)]) {
  for(const budget of [1,50,1200,4000]) assert.equal(policy.textPages(text,budget).join(''),text);
}
assert.throws(()=>policy.textPages('x',0));
assert.ok(policy.previewBudget(360,700)<policy.previewBudget(720,700));
const {shareSegments,groupShareSegments,SharePageLayout}=load('chat/TurnShare.ets','shareSegments,groupShareSegments,SharePageLayout',{textPages:policy.textPages});
const original='完整回答 👩‍💻\n'.repeat(500);
const parts=shareSegments([{role:'assistant',text:original,images:[],files:[]}]);
assert.equal(parts.map(p=>p.text).join(''),original);
const mixed=shareSegments([{role:'user',text:'问题',images:['/cache/photo.png'],files:['notes.md']},{role:'system',text:'PRIVATE_TOOL_ARGS',images:[],files:[]},{role:'assistant',text:'回答',images:[],files:[]}]);
assert.equal(mixed.length,3); assert.equal(mixed[1].images[0],'/cache/photo.png');
assert.ok(!JSON.stringify(mixed).includes('PRIVATE_TOOL_ARGS'));
assert.throws(()=>shareSegments([{role:'assistant',text:'x'.repeat(1200*81),images:[],files:[]}]),/过长/);
// Native measurement is injected, not replaced by a character-count heuristic in production.
const measuredText=text=>text.split('\n').reduce((height,line)=>height+26*Math.max(1,Math.ceil(Array.from(line).length/22)),0);
const shortTurn=Object.freeze([
  Object.freeze({role:'user',text:'UI_NORMAL',images:Object.freeze([]),files:Object.freeze([])}),
  Object.freeze({role:'assistant',text:'SIMULATOR_OK',images:Object.freeze([]),files:Object.freeze([])})
]);
const shortBefore=JSON.stringify(shortTurn);
const shortSegments=shareSegments(shortTurn);
const shortPages=groupShareSegments(shortSegments,SharePageLayout.pageHeight(2),measuredText);
assert.equal(shortPages.length,1,'a tiny complete turn must produce ONE PNG group');
assert.equal(shortPages[0].parts.map(part=>part.label).join(','),'你,LeoBot');
assert.equal(shortPages[0].parts.map(part=>part.text).join('|'),'UI_NORMAL|SIMULATOR_OK');
assert.equal(JSON.stringify(shortTurn),shortBefore);
assert.notEqual(shortPages[0].parts[0],shortSegments[0],'grouping must not retain mutable input segment objects');
assert.equal(groupShareSegments(shortSegments,shortPages[0].height,measuredText).length,1,'exact measured height fits');
assert.equal(groupShareSegments(shortSegments,shortPages[0].height-1,measuredText).length,2,'split only when the measured group exceeds the limit');
const groupedMixed=groupShareSegments(mixed,1000,measuredText);
assert.equal(groupedMixed.length,1);
assert.equal(groupedMixed[0].parts.map(part=>part.text).filter(Boolean).join('|'),'问题\n附件：notes.md|回答');
assert.equal(groupedMixed[0].parts.flatMap(part=>part.images).join('|'),'/cache/photo.png');
assert.ok(!JSON.stringify(groupedMixed).includes('PRIVATE_TOOL_ARGS'));
for (const text of [original,'\n'.repeat(1200),'👩‍💻 é\n'.repeat(400),'单行汉字'.repeat(900)]) {
  const source=shareSegments([{role:'assistant',text,images:[],files:[]}]);
  const before=JSON.stringify(source);
  for(const part of source) { Object.freeze(part.images); Object.freeze(part); } Object.freeze(source);
  const pages=groupShareSegments(source,900,measuredText);
  assert.ok(pages.length>1 && pages.length<=80);
  assert.ok(pages.every(page=>page.height<=900));
  assert.equal(pages.flatMap(page=>page.parts).map(part=>part.text).join(''),text,'all code points/newlines remain in order');
  assert.equal(JSON.stringify(source),before);
  for(const page of pages) {
    const actual=SharePageLayout.baseHeight+page.parts.reduce((height,part)=>height+SharePageLayout.gap+SharePageLayout.labelHeight+
      (part.text?SharePageLayout.partGap+measuredText(part.text):0)+part.images.length*(SharePageLayout.partGap+SharePageLayout.imageSize),0);
    assert.equal(page.height,actual);
  }
}
const photoPaths=['/cache/a.png','/cache/a.png','/cache/b.png','/cache/c.png','/cache/d.png'];
const photoSegments=shareSegments([{role:'user',text:'照片顺序',images:photoPaths,files:['one.txt','two.txt']},{role:'assistant',text:'逐张回答',images:[],files:[]}]);
const photoPages=groupShareSegments(photoSegments,700,measuredText);
assert.ok(photoPages.length>1 && photoPages.every(page=>page.height<=700));
assert.equal(photoPages.flatMap(page=>page.parts).flatMap(part=>part.images).join('|'),photoPaths.join('|'),'duplicate images are not deduplicated or reordered');
assert.equal(photoPages.flatMap(page=>page.parts).map(part=>part.text).filter(Boolean).join('|'),'照片顺序\n附件：one.txt、two.txt|逐张回答');
const imageOnly=Array.from({length:80},()=>({label:'图片',text:'',images:['/cache/photo.png']}));
const imagePageHeight=SharePageLayout.baseHeight+SharePageLayout.gap+SharePageLayout.labelHeight+SharePageLayout.partGap+SharePageLayout.imageSize;
assert.equal(groupShareSegments(imageOnly,imagePageHeight,measuredText).length,80);
assert.throws(()=>groupShareSegments([...imageOnly,imageOnly[0]],imagePageHeight,measuredText),/80/);
assert.throws(()=>groupShareSegments(shareSegments([{role:'assistant',text:'\n'.repeat(1000),images:[],files:[]}]),200,measuredText),/80/,'measured pagination cannot exceed 80 even with fewer original chunks');
assert.throws(()=>groupShareSegments(imageOnly,imagePageHeight-1,measuredText),/安全尺寸/);
for(const invalid of [0,-1,NaN,Infinity]) {
  assert.throws(()=>groupShareSegments(shortSegments,900,()=>invalid),/测量失败/);
  assert.throws(()=>SharePageLayout.pageHeight(invalid));
}
for(const ratio of [1,1.5,2,3,4]) {
  const height=SharePageLayout.pageHeight(ratio); const widthPixels=Math.ceil(SharePageLayout.width*ratio);
  assert.ok(Math.ceil(height*ratio)<=SharePageLayout.maxSidePixels);
  assert.ok(widthPixels*Math.ceil(height*ratio)<=SharePageLayout.maxPixels);
}
assert.throws(()=>SharePageLayout.pageHeight(20),/安全尺寸/);
console.log('TURN_GROUPING_OK short turn one group, measured boundary, Unicode/newlines, images/attachments/order, immutable inputs and 80-page/pixel budgets');
let now=0,nextTimer=0,commits=0;
const timers=new Map(),storage=new Map();
const {UndoDeletion}=load('store/UndoDeletion.ets','UndoDeletion',{Date:{now:()=>now},setTimeout:fn=>{timers.set(++nextTimer,fn);return nextTimer;},clearTimeout:id=>timers.delete(id),AppStorage:{get:k=>storage.get(k),setOrCreate:(k,v)=>storage.set(k,v)}});
UndoDeletion.stage('one','title',async()=>{commits++;});
assert.equal(UndoDeletion.hidden('one'),true); assert.equal(commits,0);
now=4999; assert.equal(UndoDeletion.undo('one'),true); assert.equal(UndoDeletion.hidden('one'),false); assert.equal(timers.size,0); assert.equal(commits,0);
UndoDeletion.stage('two','title',async()=>{commits++;});
now=10000; assert.equal(UndoDeletion.undo('two'),false);
await [...timers.values()][0](); assert.equal(commits,1); assert.equal(UndoDeletion.hidden('two'),false);
UndoDeletion.stage('fail','title',async()=>{throw new Error('disk');});
await [...timers.values()].at(-1)(); assert.match(UndoDeletion.error,/未完成/); assert.equal(UndoDeletion.hidden('fail'),false);
// Execute the actual pane's delayed-follow method, not a second model of that method.
const pane=fs.readFileSync(new URL('panes/LocalChatPane.ets',root),'utf8');
const match=/private followTail\(force: boolean = false\): void \{([\s\S]*?)\n  \}/.exec(pane); assert.ok(match);
let scheduled,scrolls=0;
const followTail=vm.runInNewContext(stripTypeScriptTypes('function followTail(force: boolean = false) {'+match[1]+'\n}\nfollowTail'),{setTimeout:fn=>{scheduled=fn;},FollowState:policy.FollowState,ScrollAlign:{END:1},Edge:{Bottom:1}});
const view={items:[{}],nearBottom:true,followGeneration:0,currentId:'a',alive:true,chatScroller:{scrollToIndex(){scrolls++;},scrollEdge(){scrolls++;}}};
followTail.call(view);view.nearBottom=false;view.followGeneration++;scheduled();assert.equal(scrolls,0,'manual scroll must invalidate an already queued follow');
followTail.call(view,true);scheduled();assert.equal(scrolls,2);
followTail.call(view);view.currentId='b';scheduled();assert.equal(scrolls,2,'stale session callback cannot scroll a different conversation');
console.log('CHAT_UX_OK real policies, Unicode preservation, selected-turn sharing, timed delete/undo/failure and queued-scroll race');
// Exercise production share-file lifecycle with fake platform APIs; this is NOT a rendering test.
const shareSource=fs.readFileSync(new URL('pages/TurnSharePage.ets',root),'utf8');
const generateMatch=/private async generate\(\): Promise<void> \{([\s\S]*?)\n  \}/.exec(shareSource);assert.ok(generateMatch);
const groupMatch=/private groupPages\(\): SharePage\[\] \{([\s\S]*?)\n  \}/.exec(shareSource);assert.ok(groupMatch);
const groupPages=vm.runInNewContext(stripTypeScriptTypes('function groupPages() {'+groupMatch[1]+'\n}\ngroupPages'),{
  groupShareSegments,SharePageLayout,WordBreak:{BREAK_WORD:1}
});
const measures=[];
const nativeGrouped=groupPages.call({parts:shortSegments,getUIContext:()=>({vp2px:value=>value*2,px2vp:value=>value/2,
  getMeasureUtils:()=>({measureTextSize:options=>{measures.push(options);return {height:measuredText(options.textContent)*2};}})})});
assert.equal(nativeGrouped.length,1);assert.equal(nativeGrouped[0].height,shortPages[0].height,'physical measurement is converted back to vp');
assert.ok(measures.every(options=>options.fontSize==='16vp' && options.lineHeight==='26vp' && options.constraintWidth==='360vp' && options.wordBreak===1));

function shareHarness(pages, options={}) {
  const counts={snapshots:0,maps:0,packers:0,packerReleases:0,files:0,closes:0,removed:[],captured:[]};
  let shareView;
  const generate=vm.runInNewContext(stripTypeScriptTypes('async function generate() {'+generateMatch[1]+'\n}\ngenerate'),{
    getContext:()=>({cacheDir:'/cache'}),Date,SharePageLayout,
    image:{createImagePacker:()=>{
      counts.packers++;if(options.failPacker)throw new Error('packer');
      return {packing:async()=>new Uint8Array([1,2,3]).buffer,release:async()=>{counts.packerReleases++;}};
    }},
    fileIo:{OpenMode:{CREATE:1,READ_WRITE:2,TRUNC:4},openSync:()=>{counts.files++;return {fd:7};},
      writeSync:(_fd,bytes)=>options.shortWrite?1:bytes.byteLength,closeSync:()=>{counts.closes++;},unlinkSync:path=>counts.removed.push(path)}
  });
  shareView={busy:false,segments:pages,alive:true,paths:[],groupPages:()=>pages,
    snapshotPage:page=>counts.captured.push(page.parts.map(part=>part.label).join(',')),
    getUIContext:()=>({getComponentSnapshot:()=>({createFromBuilder:async builder=>{
      counts.snapshots++;builder();
      if(counts.snapshots===options.cancelAt)shareView.alive=false;
      return {getImageInfo:async()=>({size:{width:400,height:counts.snapshots===options.oversizeAt?5000:300}}),release:async()=>{counts.maps++;}};
    }})})};
  return {view:shareView,counts,run:()=>generate.call(shareView)};
}
let shareCase=shareHarness(shortPages);await shareCase.run();
assert.equal(shareCase.view.paths.length,1);assert.equal(shareCase.view.busy,false);assert.equal(shareCase.counts.snapshots,1);
assert.equal(shareCase.counts.captured[0],'你,LeoBot','both roles reach the SAME native builder capture');
assert.equal(shareCase.counts.maps,1);assert.equal(shareCase.counts.packerReleases,1);assert.equal(shareCase.counts.closes,1);
shareCase=shareHarness(shortPages,{shortWrite:true});await shareCase.run();
assert.equal(shareCase.view.paths.length,0);assert.match(shareCase.view.error,/生成失败/);assert.equal(shareCase.counts.removed.length,1);
assert.equal(shareCase.counts.maps,1);assert.equal(shareCase.counts.packerReleases,1);assert.equal(shareCase.counts.closes,1);
shareCase=shareHarness(shortPages,{failPacker:true});await shareCase.run();assert.equal(shareCase.counts.maps,1);assert.equal(shareCase.counts.files,0);
shareCase=shareHarness(shortPages,{oversizeAt:1});await shareCase.run();
assert.equal(shareCase.counts.maps,1);assert.equal(shareCase.counts.packers,0);assert.equal(shareCase.view.paths.length,0);
shareCase=shareHarness(photoPages,{oversizeAt:2});await shareCase.run();
assert.equal(shareCase.counts.maps,2);assert.equal(shareCase.counts.packerReleases,1);assert.equal(shareCase.counts.removed.length,1);assert.equal(shareCase.view.paths.length,0);
shareCase=shareHarness(photoPages,{cancelAt:2});await shareCase.run();
assert.equal(shareCase.counts.maps,2);assert.equal(shareCase.counts.packerReleases,1);assert.equal(shareCase.counts.removed.length,1);assert.equal(shareCase.view.paths.length,0);
console.log('TURN_SHARE_IO_OK one native capture for both roles, pixel guard, short-write/factory failure/cancellation and cleanup (platform mocks, not PNG rendering)');
// Actual delete handler must refuse stale/active runs and roll back an I/O failure.
const deleteMatch=/private async deleteTurn\(item: ChatItem\): Promise<void> \{([\s\S]*?)\n  \}/.exec(pane);assert.ok(deleteMatch);
let session,failWrite=false,writes=0;
const deleteTurn=vm.runInNewContext(stripTypeScriptTypes('async function deleteTurn(item) {'+deleteMatch[1]+'\n}\ndeleteTurn'),{
  getContext:()=>({}),Tokens:{danger:'danger',secondary:'secondary'},promptAction:{showDialog:async()=>({index:0})},
  sessionStore:{get:async()=>session,replaceMessages:async()=>{writes++;if(failWrite)throw new Error('disk');}},
  ChatRuns:{invalidateIdle(){},bump(){}}
});
function deletionView() {
  const messages=[{role:'user',text:'one'},{role:'assistant',text:'answer one'},{role:'user',text:'two'},{role:'assistant',text:'answer two'}];
  session={messages};const run={active:false,askWrite:false,submitting:false,lines:messages};
  return {run,currentId:'session-a',lines:messages,messageBusy:false,turnStart:()=>0,saveViewState(){},detach(){},attach(){}};
}
let deleteView=deletionView();deleteView.run.active=true;await deleteTurn.call(deleteView,{index:1});assert.equal(writes,0);assert.equal(session.messages.length,4);
deleteView=deletionView();await deleteTurn.call(deleteView,{index:1});assert.equal(writes,1);assert.equal(session.messages.length,2);assert.equal(session.messages[0].text,'two');
deleteView=deletionView();failWrite=true;await deleteTurn.call(deleteView,{index:1});assert.equal(session.messages.length,4);assert.match(deleteView.status,/删除失败/);assert.equal(deleteView.messageBusy,false);
console.log('TURN_DELETE_OK production complete-turn boundary, active-run guard and failed-write rollback');
