import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

const source = process.env.PAPERCLIP_SOURCE;
const candidate = process.env.PAPERCLIP_CANDIDATE;
const patches = JSON.parse(fs.readFileSync(new URL('../catalogs/agent-runtime-controls.structural.json', import.meta.url)));
const original = file => execFileSync('git', ['show', `HEAD:${file}`], { cwd: source, encoding: 'utf8', maxBuffer: 20e6 });
function patched(file) {
  let text = original(file);
  for (const patch of patches.filter(p => p.file === file)) {
    assert.equal(text.split(patch.from).length - 1, patch.expected);
    text = text.split(patch.from).join(patch.to);
  }
  let restored = text;
  for (const patch of patches.filter(p => p.file === file)) restored = restored.split(patch.to).join(patch.from);
  assert.equal(restored, original(file), `only reviewed display copy changes: ${file}`);
  return text;
}
function find(text, predicate) {
  const ast = ts.createSourceFile('runtime.tsx', text, ts.ScriptTarget.Latest, true);
  const result = [];
  function visit(node) { if (predicate(node, ast)) result.push(node); ts.forEachChild(node, visit); }
  visit(ast);
  return { ast, result };
}
function check(read) {
  const actions = read('ui/src/components/AgentActionButtons.tsx');
  const run = find(actions, n => ts.isBindingElement(n) && n.name.getText() === 'runLabel');
  assert.equal(run.result.length, 1);
  assert.equal(run.result[0].initializer.text, '立即运行');
  assert.ok(actions.includes('label={runLabel}'), 'custom run labels still flow to the action');

  const detail = read('ui/src/pages/AgentDetail.tsx');
  const titles = find(detail, n => ts.isJsxAttribute(n) && n.name.getText() === 'sectionTitles');
  assert.equal(titles.result.length, 1);
  const sectionTitles = titles.result[0].initializer.expression.properties;
  const labels = Object.fromEntries(sectionTitles.map(p => [p.name.getText(), p.initializer.text]));
  assert.equal(labels.adapter, '适配器');
  assert.equal(labels.configuration, '配置');

  const form = read('ui/src/components/AgentConfigForm.tsx');
  const reasoning = find(form, n => ts.isCallExpression(n) && n.expression.getText() === 'codexReasoningEffortOptions');
  assert.equal(reasoning.result.length, 1);
  assert.equal(reasoning.result[0].arguments[0].getText(), 'currentModelId');
  assert.equal(reasoning.result[0].arguments[1].text, '自动');
  assert.ok(form.includes('id: option.value'), 'reasoning selection preserves adapter option values');

  const runtime = read('ui/src/components/RuntimeTestCard.tsx');
  const declarations = find(runtime, n => ts.isVariableDeclaration(n) && n.name.getText() === 'copy');
  assert.equal(declarations.result.length, 1);
  const initializer = declarations.result[0].initializer.getText(declarations.ast);
  const js = ts.transpileModule(`const copy = ${initializer};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const copy = new Function(`${js};return copy;`)();
  assert.deepEqual(Object.keys(copy), ['idle', 'running', 'pass', 'warn', 'fail']);
  assert.deepEqual(Object.fromEntries(Object.entries(copy).map(([state, value]) => [state, value.action])), { idle: '运行测试', running: '正在测试…', pass: '再次测试', warn: '再次测试', fail: '重试测试' });
  // Diagnostics remain the adapter's raw values, including nested PATH errors.
  for (const expression of ['{state === "fail" && error ? error : content.description}', '{check.message}', '{check.detail}', '{check.hint}', 'disabled={disabled || state === "running"}', 'onClick={onTest}']) assert.ok(runtime.includes(expression), expression);
}
test('runtime action copy localizes all five test states without altering execution or diagnostics', { skip: !source }, () => check(patched));
test('generated candidate has Chinese runtime actions, adapter headings and automatic reasoning', { skip: !source || !candidate }, () => check(file => fs.readFileSync(path.join(candidate, file), 'utf8')));
