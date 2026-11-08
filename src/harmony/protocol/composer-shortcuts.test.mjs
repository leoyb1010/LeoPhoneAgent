// Executes the production callback. The adapter models the documented pre-IME consumed=true contract.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
const source=fs.readFileSync(new URL('../app/entry/src/main/ets/chat/Composer.ets',import.meta.url),'utf8');
const begin=source.indexOf('.onKeyPreIme(')+'.onKeyPreIme('.length;
assert.ok(begin>20,'the shortcut must run before the IME default insertion');
const end=source.indexOf('\n        })',begin)+'\n        }'.length;
const context=vm.createContext({KeyCode:{KEYCODE_ENTER:2054},KeyType:{Down:0,Up:1}});
vm.runInContext(stripTypeScriptTypes('globalThis.make=function(){return '+source.slice(begin,end)+';}',{mode:'strip'}),context);
let sends=0;
const host={draft:'完整草稿🙂',allowed:true,canSend(){return this.allowed&&this.draft.trim().length>0;},onSend(){sends++;this.draft='';}};
const handle=context.make.call(host);
function deliver({ctrl=false,meta=0,type=0,key=2054}={}){
 const consumed=handle({keyCode:key,type,metaKey:meta,getModifierKeyState:keys=>ctrl&&keys.includes('Ctrl')});
 if(!consumed&&type===0&&key===2054)host.draft+='\n';
 return consumed;
}
assert.equal(deliver({ctrl:true}),true);assert.equal(sends,1);assert.equal(host.draft,'','Ctrl+Enter does not insert a newline after admission clears the draft');
assert.equal(deliver({ctrl:true,type:1}),true);assert.equal(sends,1,'keyup does not send twice');
host.draft='下一句';assert.equal(deliver(),false);assert.equal(host.draft,'下一句\n');assert.equal(sends,1,'plain Enter retains the normal newline behavior');
host.allowed=false;const before=host.draft;assert.equal(deliver({ctrl:true}),true);assert.equal(host.draft,before);assert.equal(sends,1,'busy shortcut cannot send or mutate the retained draft');
host.allowed=true;assert.equal(deliver({meta:1}),true);assert.equal(sends,2);assert.equal(host.draft,'');
console.log('HARMONY_COMPOSER_SHORTCUTS_OK production pre-IME callback, Ctrl/Cmd admission, keyup isolation, no post-send newline and plain Enter behavior');
// The source method retains a failed native focus ticket and consumes only a successful visible/layout attempt.
const focusStart=source.indexOf('  private applyFocus(): void {');const focusEnd=source.indexOf('  private canSend():',focusStart);
const focusContext=vm.createContext({});vm.runInContext(stripTypeScriptTypes('class FocusHost{'+source.slice(focusStart,focusEnd).replace('private applyFocus','applyFocus')+'}globalThis.FocusHost=FocusHost;',{mode:'strip'}),focusContext);
const focusHost=new focusContext.FocusHost();let focusCalls=0,applied=0,missing=true;
Object.assign(focusHost,{layoutReady:false,ready:true,inputId:'homeComposerInput',focusRequest:7,appliedFocus:0,onFocusApplied:ticket=>applied=ticket,getUIContext:()=>({getFocusController:()=>({requestFocus(){focusCalls++;if(missing)throw new Error('150003 invisible native input');}})})});
focusHost.applyFocus();assert.equal(focusCalls,0,'no native focus request before input layout');focusHost.layoutReady=true;assert.doesNotThrow(()=>focusHost.applyFocus());assert.equal(applied,0,'transient missing input retains its pending ticket');missing=false;focusHost.applyFocus();assert.equal(applied,7);assert.equal(focusHost.appliedFocus,7);focusHost.applyFocus();assert.equal(focusCalls,2,'a consumed ticket cannot refocus after fold remount callbacks');
const pane=fs.readFileSync(new URL('../app/entry/src/main/ets/panes/LocalAgentPane.ets',import.meta.url),'utf8');const createStart=pane.indexOf('  private async createSession(): Promise<void> {');const createEnd=pane.indexOf('  private ',createStart+8);
const newContext=vm.createContext({HomeAttachment:{focusSequence:0},LocalChatLaunch:{sessionId:'old'},setTimeout:()=>{throw new Error('unbound timer focus forbidden');},sessionStore:{create(){throw new Error('draft cannot create Session');}}});
vm.runInContext(stripTypeScriptTypes('class NewHost{'+pane.slice(createStart,createEnd).replace('private async createSession','async createSession')+'}globalThis.NewHost=NewHost;',{mode:'strip'}),newContext);const newHost=new newContext.NewHost();newHost.sessionId='old';await newHost.createSession();assert.equal(newHost.sessionId,'');assert.equal(newHost.homeFocusTicket,1);await newHost.createSession();assert.equal(newHost.homeFocusTicket,2);
console.log('HARMONY_COMPOSER_FOCUS_OK production ticket/layout gate, recoverable native 150003, exactly-once focus and zero-Session New action');
