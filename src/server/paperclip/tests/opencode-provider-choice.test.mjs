import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
const source = process.env.PAPERCLIP_SOURCE;
const candidate = process.env.PAPERCLIP_CANDIDATE;
const file = 'ui/src/components/new-agent/NewAgentSetup.tsx';
const patches = JSON.parse(fs.readFileSync(new URL('../catalogs/opencode-provider-choice.structural.json', import.meta.url)));
function patched(){let text=execFileSync('git',['show',`HEAD:${file}`],{cwd:source,encoding:'utf8'});for(const patch of patches){assert.equal(text.split(patch.from).length-1,patch.expected);text=text.split(patch.from).join(patch.to);}return text;}
function check(text){
 const ast=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);assert.deepEqual(ast.parseDiagnostics,[]);
 const bindings=[];function visit(n){if(ts.isVariableDeclaration(n)&&n.name.getText(ast)==='[runtimeAiBinding, setRuntimeAiBinding]')bindings.push(n);ts.forEachChild(n,visit);}visit(ast);assert.equal(bindings.length,1);assert.equal(bindings[0].initializer.arguments.length,0,'choosing the CLI must not synthesize any managed account');
 assert.ok(text.includes('hasCredentialField && !aiBinding'),'the original provider/API env flow remains available without managed binding');
 assert.ok(text.includes('Object.keys(providerKeys).map'),'provider choices remain sourced from the existing adapter contract');
 assert.ok(text.includes('const envKey =\n    SETUP_CREDENTIAL_KEYS[adapterType] ?? providerKeys[provider] ?? "API_KEY";'),'each chosen provider keeps its original environment key');
 assert.ok(text.includes('brandType !== "opencode_local" || showOpenCodeManaged || Boolean(aiBinding)'),'the optional OpenRouter UI cannot misrepresent the default CLI selection');
 assert.ok(text.includes('setRuntimeAiBinding(binding); resetTest();'),'managed connections still flow through the original explicit selection handler');
 assert.ok(text.includes('setRuntimeAiBinding(undefined); setConnection(null); setShowOpenCodeManaged(false)'),'the user can leave managed binding and use the server CLI configuration');
 assert.ok(text.includes('运行方式是 OpenCode CLI，默认沿用服务器已有授权与配置'),'the interface distinguishes execution tool and model provider');
 const declarations=[];function pending(node){if(ts.isFunctionDeclaration(node)&&node.name?.text==='pendingCredentials')declarations.push(node);ts.forEachChild(node,pending);}pending(ast);assert.equal(declarations.length,1);
 const js=ts.transpileModule(declarations[0].getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const credentialContext={connection:null,aiBinding:undefined,brandType:'opencode_local',showOpenCodeApi:false,hasCredentialField:true,apiKey:'fixture-only-key',envKey:'OPENAI_API_KEY'};
 const evaluate=()=>Function(...Object.keys(credentialContext),`${js};return pendingCredentials();`)(...Object.values(credentialContext));
 assert.deepEqual(evaluate(),{},'a collapsed API panel cannot leak a previously entered key into the create payload');
 credentialContext.showOpenCodeApi=true;assert.deepEqual(evaluate(),{OPENAI_API_KEY:'fixture-only-key'},'explicit API configuration retains the original provider key');

}
test('OpenCode setup does not invent a managed OpenRouter account and keeps explicit provider selection', {skip:!source},()=>check(patched()));
test('generated OpenCode setup retains independent CLI/provider choices and optional managed bindings', {skip:!source||!candidate},()=>check(fs.readFileSync(path.join(candidate,file),'utf8')));
