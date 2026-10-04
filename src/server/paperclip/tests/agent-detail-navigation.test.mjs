import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

const source = process.env.PAPERCLIP_SOURCE;
const candidate = process.env.PAPERCLIP_CANDIDATE;
const lock = JSON.parse(fs.readFileSync(new URL('../upstream.lock.json', import.meta.url)));
const patches = JSON.parse(fs.readFileSync(new URL('../catalogs/agent-detail-navigation.structural.json', import.meta.url)));
const navigationFile = 'ui/src/pages/agent-detail-navigation.ts';
const sidebarFile = 'ui/src/components/AgentContextualSidebar.tsx';
const detailFile = 'ui/src/pages/AgentDetail.tsx';
const expectedNavigation = [
  { label: '智能体', items: [{ value: 'overview', label: '概览' }, { value: 'instructions', label: '指令' }, { value: 'skills', label: '技能' }] },
  { label: '运行环境', items: [{ value: 'runtime', label: '执行框架 / 运行环境' }, { value: 'secrets', label: '密钥' }, { value: 'tools', label: '工具' }, { value: 'channels', label: '通道' }] },
  { label: '治理', items: [{ value: 'permissions', label: '权限 / 信任' }, { value: 'api-keys', label: 'API 密钥' }, { value: 'revisions', label: '修订版本' }] },
];
const original = file => execFileSync('git', ['show', `HEAD:${file}`], { cwd: source, encoding: 'utf8', maxBuffer: 20e6 });
function patched(file) {
  let text = original(file);
  for (const patch of patches.filter(p => p.file === file)) {
    assert.equal(text.split(patch.from).length - 1, patch.expected, `pinned patch context: ${file}`);
    text = text.split(patch.from).join(patch.to);
  }
  return text;
}
function nodes(text, file, predicate) {
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const result = [];
  function visit(node) { if (predicate(node, ast)) result.push(node); ts.forEachChild(node, visit); }
  visit(ast);
  return { ast, result };
}
function navigation(text) {
  const js = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  const require = name => {
    assert.equal(name, './audit/audit-navigation');
    return { auditSectionHref: (section, options) => ({ section, options }) };
  };
  new Function('exports', 'require', js)(exports, require);
  return exports;
}
function checkNavigation(text) {
  const localized = navigation(text);
  const upstream = navigation(original(navigationFile));
  assert.deepEqual(localized.AGENT_DETAIL_NAVIGATION, expectedNavigation);
  const values = expectedNavigation.flatMap(section => section.items.map(item => item.value));
  assert.deepEqual(values, upstream.AGENT_DETAIL_NAVIGATION.flatMap(section => section.items.map(item => item.value)));
  for (const agentRef of ['English Agent', '智能体', 'custom-agent-id']) {
    assert.equal(localized.agentDetailHref(agentRef), `/agents/${agentRef}/overview`);
    for (const value of values) assert.equal(localized.agentDetailHref(agentRef, value), upstream.agentDetailHref(agentRef, value));
  }
  const aliases = { prompts: 'instructions', configure: 'runtime', configuration: 'runtime', trust: 'permissions', keys: 'api-keys', history: 'revisions' };
  for (const value of [...values, ...Object.keys(aliases), null, '', 'unknown']) {
    assert.equal(localized.parseAgentDetailView(value), aliases[value] ?? (values.includes(value) ? value : 'overview'));
    assert.equal(localized.parseAgentDetailView(value), upstream.parseAgentDetailView(value));
  }
  for (const value of [null, '', 'runs', 'audit', 'activity', 'cost', 'costs', 'budget', 'budgets', 'unknown']) assert.equal(localized.agentLegacyAuditSection(value), upstream.agentLegacyAuditSection(value));
  for (const section of ['activity', 'runs', 'costs', 'budgets']) assert.deepEqual(localized.agentScopedAuditHref('custom-agent-id', section), upstream.agentScopedAuditHref('custom-agent-id', section));
  // Stronger than literal checks: the whole module is identical after undoing the display labels.
  let restored = text;
  for (const patch of patches.filter(p => p.file === navigationFile)) restored = restored.split(patch.to).join(patch.from);
  assert.equal(restored, original(navigationFile));
}
function checkSecrets(sidebar, detail) {
  const defaults = nodes(sidebar, sidebarFile, n => ts.isBindingElement(n) && n.name.getText() === 'labels');
  assert.equal(defaults.result.length, 1);
  assert.deepEqual(new Function(`return (${defaults.result[0].initializer.getText(defaults.ast)});`)(), { secrets: '密钥与变量' });
  const headings = nodes(detail, detailFile, (n, ast) => ts.isConditionalExpression(n) && n.condition.getText(ast) === 'activeView === "secrets"' && n.whenFalse.getText(ast).startsWith('AGENT_DETAIL_NAVIGATION'));
  assert.equal(headings.result.length, 1);
  const heading = new Function('activeView', 'AGENT_DETAIL_NAVIGATION', `return (${headings.result[0].getText(headings.ast)});`);
  assert.equal(heading('secrets', expectedNavigation), '密钥与变量');
  for (const item of expectedNavigation.flatMap(section => section.items).filter(item => item.value !== 'secrets')) assert.equal(heading(item.value, expectedNavigation), item.label);
  assert.ok(sidebar.includes('label={labels?.[item.value] ?? item.label}'));
  const labelAttributes = nodes(sidebar, sidebarFile, (n, ast) => ts.isJsxAttribute(n) && n.name.getText(ast) === 'label' && n.initializer?.getText(ast) === '{labels?.[item.value] ?? item.label}');
  assert.equal(labelAttributes.result.length, 1);
  const displayLabel = new Function('labels', 'item', `return (${labelAttributes.result[0].initializer.expression.getText(labelAttributes.ast)});`);
  const names = nodes(sidebar, sidebarFile, n => ts.isVariableDeclaration(n) && n.name.getText() === 'resolvedName');
  assert.equal(names.result.length, 1);
  const resolveName = new Function('agentName', 'resolvedAgent', `return (${names.result[0].initializer.getText(names.ast)});`);
  for (const name of ['Agent', 'English Name', '李用户', '<b>Custom</b>']) {
    assert.equal(resolveName(name, { name: 'other' }), name);
    assert.equal(resolveName(undefined, { name }), name);
    assert.equal(displayLabel({ secrets: name }, { value: 'secrets', label: '密钥' }), name);
  }
  assert.equal(displayLabel(undefined, { value: 'tools', label: '工具' }), '工具');
}
test('agent detail sections, all menu labels and exact navigation contracts remain stable', { skip: !source }, () => {
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(), lock.commit);
  checkNavigation(patched(navigationFile));
});
test('secrets default override and page heading agree while custom labels and names stay intact', { skip: !source }, () => checkSecrets(patched(sidebarFile), patched(detailFile)));
test('generated candidate contains the complete Chinese agent navigation and secrets override', { skip: !source || !candidate }, () => {
  checkNavigation(fs.readFileSync(path.join(candidate, navigationFile), 'utf8'));
  const sidebar = fs.readFileSync(path.join(candidate, sidebarFile), 'utf8');
  checkSecrets(sidebar, fs.readFileSync(path.join(candidate, detailFile), 'utf8'));
  const audit = nodes(sidebar, sidebarFile, n => ts.isVariableDeclaration(n) && n.name.getText() === 'auditItems');
  assert.equal(audit.result.length, 1);
  const items = audit.result[0].initializer.expression.elements.map(item => Object.fromEntries(item.properties.filter(p => ['section', 'label'].includes(p.name.getText())).map(p => [p.name.getText(), p.initializer.text])));
  assert.deepEqual(items, [{ section: 'activity', label: '活动记录' }, { section: 'runs', label: '运行记录' }, { section: 'costs', label: '费用' }, { section: 'budgets', label: '预算' }]);
  assert.ok(sidebar.includes('{"审计"}'));
});
