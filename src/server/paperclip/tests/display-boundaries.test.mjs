import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { source, patched as patchedFile } from './helpers/patched.mjs';
const patches=JSON.parse(fs.readFileSync(new URL('../catalogs/zz-display-boundaries.structural.json',import.meta.url)));
const patched=file=>ts.createSourceFile(file,patchedFile(file,patches),ts.ScriptTarget.Latest,true);
function nodes(ast,predicate){const result=[];function visit(n){if(predicate(n))result.push(n);ts.forEachChild(n,visit);}visit(ast);return result;}
const names=['English Name','未分配','Properties','<b>李用户</b>','A ${script}'];
test('composer fixed copy is Chinese in all six modes while assignee names stay exact',{skip:!source},()=>{
  const ast=patched('ui/src/components/task-chat/TaskChatComposer.tsx');
  const fn=nodes(ast,n=>ts.isFunctionDeclaration(n)&&n.name?.text==='modePlaceholder')[0];
  assert.ok(fn);
  const js=ts.transpileModule(fn.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const placeholder=new Function(js+';return modePlaceholder;')();
  for(const name of names)for(const mode of ['planning','ask','execute'])for(const mobile of [true,false]){
    const value=placeholder(mode,name,mobile);assert.ok(value.includes(name));
    assert.ok(value.startsWith(mode==='planning'?'与 ':mode==='ask'?'向 ':'给 '));
    assert.ok(!/describe what you want|shapes the plan doc|read-only/.test(value));
  }
});
test('sidebar collapse/expand and close accessibility copy retains custom names',{skip:!source},()=>{
  for(const [file,prefixes] of [['ui/src/components/SidebarSection.tsx',['收起','展开']],['ui/src/components/side-panel/SidePanelTab.tsx',['关闭']]]){
    const ast=patched(file);
    const templates=nodes(ast,n=>ts.isTemplateExpression(n)&&prefixes.includes(n.head.text));
    assert.equal(templates.length,prefixes.length);
    for(const template of templates){const expression=template.getText(ast);const value=new Function('label','return '+expression);for(const name of names)assert.equal(value(name),template.head.text+name);}
  }
});
test('system tabs localize by semantic payload and restored custom names are untouched',{skip:!source},()=>{
  const ast=patched('ui/src/components/task-side-panel/TaskSidePanel.tsx');
  const declaration=nodes(ast,n=>ts.isVariableDeclaration(n)&&n.name.getText(ast)==='systemTabLabel')[0];
  assert.ok(declaration);
  const label=new Function('tab','taskLabel','return '+declaration.initializer.getText(ast));
  assert.equal(label({payload:{kind:'properties'},label:'Properties'},'子任务'),'属性');
  assert.equal(label({payload:{kind:'artifacts'},label:'Artifacts'},'子任务'),'成果文件');
  assert.equal(label({payload:{kind:'subtasks'},label:'Subtasks'},'子任务'),'子任务');
  for(const kind of ['skill','attachment','workspace-file','issue-document','browser'])for(const name of names){const tab={payload:{kind},label:name};assert.equal(label(tab,'子任务')??tab.label,name);assert.equal(tab.label,name);}
});
