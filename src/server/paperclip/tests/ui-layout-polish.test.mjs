// 1.1.7：中文版式与显示文案整理（catalogs/ui-layout-polish.structural.json + overlays/zh-cn-layout.css）。
// 回放固定源码上的精确补丁，核对：上下文唯一、模板插值不丢失、搜索语法示例改为中文芯片、
// 新建任务对话框标签不再使用为英文 "For" 预留的 24px 列、lib 生成的交互标题为中文，
// 以及候选树中不再存在按英文语序逐词拼接的计数模板和未解码的 HTML 实体。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { source, candidate, original, patched as patchedFile, readJson } from './helpers/patched.mjs';

const patches = JSON.parse(fs.readFileSync(new URL('../catalogs/ui-layout-polish.structural.json', import.meta.url)));
const patched = file => patchedFile(file, patches, { reversible: true });
const files = [...new Set(patches.map(p => p.file))];
const interpolations = text => [...new Set([...text.matchAll(/\$\{\s*([A-Za-z_][\w.]*)/g)].map(m => m[1]))];
const CJK = /[㐀-鿿]/;

test('catalog is registered and every rule targets ui/src with Chinese or layout-only output', () => {
  const order = readJson('catalogs/order.json');
  assert.ok(order.structural.includes('ui-layout-polish.structural.json'));
  for (const p of patches) {
    assert.match(p.file, /^ui\/src\/.+\.tsx?$/);
    assert.ok(p.from.length > 0 && p.to !== p.from);
    // 模板插值只增不减：译文不能丢掉原文引用的变量。
    { const after = interpolations(p.to); for (const expr of interpolations(p.from)) assert.ok(after.includes(expr), `${p.file}: 插值 ${expr} 丢失`); }
    // 版式类规则只改 className；文案类规则输出含中文。
    const layoutOnly = p.from.replace(/"[^"]*"/g, '""') === p.to.replace(/"[^"]*"/g, '""') && !CJK.test(p.to);
    if (!layoutOnly) assert.ok(CJK.test(p.to) || /\{"[^"]*"\}|UserRound|useCompany|selectedCompany|displayStatus|\.label\}/.test(p.to), `${p.file}: ${p.to.slice(0, 60)}`);
  }
});

test('every rule applies exactly once on the pinned source and reverses cleanly', { skip: !source }, () => {
  for (const file of files) assert.ok(patched(file));
});

test('new-issue dialog: the 24px "For" column becomes an icon column with an accessible Chinese name', { skip: !source }, () => {
  const text = patched('ui/src/components/NewIssueDialog.tsx');
  assert.ok(!text.includes('<span className="w-6 shrink-0 text-center">For</span>'));
  assert.ok(!/w-6 shrink-0 text-center">[^<{]/.test(text), '没有固定 24px 宽的文字标签');
  assert.ok(text.includes('<UserRound className="h-3.5 w-3.5" aria-hidden />'));
  assert.ok(text.includes('<span className="sr-only">{"适用对象"}</span>'));
  assert.ok(/import \{[\s\S]*UserRound,[\s\S]*\} from "lucide-react"/.test(text));
});

test('search: raw operator hint becomes labelled example chips; identifier example uses the company prefix', { skip: !source }, () => {
  const text = patched('ui/src/pages/Search.tsx');
  assert.ok(!text.includes('Try <code'));
  assert.ok(text.includes('data-testid="search-example-chips"'));
  for (const token of ['status:todo', 'assignee:me', 'updated:>7d']) assert.ok(text.includes(`example.token === "${token}"`), token);
  assert.ok(text.includes('applySearchOperatorSuggestion(draftQuery, example.token)'));
  assert.ok(!text.includes('>PAP-123</code>'));
  assert.ok(text.includes('{`${selectedCompany?.issuePrefix ?? "PAP"}-123`}'));
  assert.ok(text.includes('const { selectedCompany } = useCompany();'));
});

function execute(text, requires = {}) {
  const js = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  new Function('exports', 'require', js)(exports, name => { if (!(name in requires)) throw new Error(`unexpected require ${name}`); return requires[name]; });
  return exports;
}

test('search operator suggestions keep their tokens and get Chinese labels', { skip: !source }, () => {
  const file = 'ui/src/lib/search-query-parser.ts';
  const shared = { ISSUE_STATUSES: ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'], ISSUE_PRIORITIES: ['critical', 'high', 'medium', 'low'] };
  const now = execute(patched(file), { '@paperclipai/shared': shared });
  const before = execute(original(file), { '@paperclipai/shared': shared });
  assert.deepEqual(now.SEARCH_OPERATOR_SUGGESTIONS.map(s => s.token), before.SEARCH_OPERATOR_SUGGESTIONS.map(s => s.token));
  assert.deepEqual(now.SEARCH_OPERATOR_QUICK_FILTERS, before.SEARCH_OPERATOR_QUICK_FILTERS);
  for (const s of now.SEARCH_OPERATOR_SUGGESTIONS) { assert.ok(CJK.test(s.label), s.token); assert.ok(CJK.test(s.description), s.token); }
  assert.equal(now.applySearchOperatorSuggestion('auth sta', 'status:todo'), before.applySearchOperatorSuggestion('auth sta', 'status:todo'));
  assert.deepEqual(now.searchOperatorSuggestions('', 7).map(s => s.token), before.searchOperatorSuggestions('', 7).map(s => s.token));
});

test('interaction summaries are Chinese and keep the same counts as upstream', { skip: !source }, () => {
  const file = 'ui/src/lib/issue-thread-interactions.ts';
  const text = patched(file);
  const body = text.slice(text.indexOf('export function buildIssueThreadInteractionSummary'), text.indexOf('export function buildAnsweredQuestionsDeliveryText'));
  assert.ok(!/return "[A-Za-z][^"]*"/.test(body), '摘要函数没有剩余英文字面量');
  assert.ok(!/return `[A-Za-z][^`]*`/.test(body));
  assert.ok(body.includes('`连接 ${interaction.payload.serviceName}`'));
  assert.ok(body.includes('`已回答 ${count} 个问题`'));
  const audience = patched('ui/src/lib/interaction-audience.ts');
  assert.ok(!audience.split('\n').some(line => !/^\s*(\/\/|\*|\/\*)/.test(line) && line.includes('can respond')));
  assert.ok(audience.includes('`仅 ${addressee} 可以回复。`'));
});

test('layout-only rules add shrink-0/whitespace-nowrap/min-w-0 and never change text', { skip: !source }, () => {
  const layoutFiles = ['ui/src/pages/AgentDetail.tsx', 'ui/src/pages/AgentDetail.production.tsx', 'ui/src/components/task-chat/TaskChatMarker.tsx', 'ui/src/components/FrontmatterPanel.tsx', 'ui/src/components/AgentActionButtons.tsx'];
  const strip = s => s.replace(/className=\{?[^}>]*\}?/g, '').replace(/\s+/g, ' ');
  for (const file of layoutFiles) {
    const before = original(file), after = patched(file);
    const layoutRules = patches.filter(p => p.file === file && !CJK.test(p.to));
    for (const p of layoutRules) assert.equal(strip(p.from), strip(p.to), `${file}: 只改 className`);
    assert.ok(after !== before);
  }
  assert.ok(patched('ui/src/components/task-chat/TaskChatMarker.tsx').includes('shrink-0 whitespace-nowrap font-medium'));
  assert.ok(patched('ui/src/components/AgentActionButtons.tsx').includes('flex flex-wrap items-center gap-1 sm:gap-2'));
});

const PIECEWISE = /\{"[^"]*"\}\s*\{[^{}]*(?:=== 1|> 1|!== 1)\s*\?\s*"([^"]+)"\s*:\s*"\1"\}|(?:=== 1|> 1|!== 1)\s*\?\s*"([^"]+)"\s*:\s*"\2"\}\s*\{"/;
const PIECEWISE_ALLOW = new Set(['ui/src/pages/Secrets.tsx']); // “3 个匹配项（所有文件夹）”语序正确，保留。
function walk(dir, out = []) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p); } return out; }

test('candidate tree: no count template is stitched in English word order, no literal HTML entities remain', { skip: !candidate }, () => {
  const root = path.join(candidate, 'ui/src');
  const offenders = [], entities = [];
  for (const file of walk(root)) {
    const rel = path.relative(candidate, file);
    const text = fs.readFileSync(file, 'utf8');
    if (!PIECEWISE_ALLOW.has(rel)) for (const [i, line] of text.split('\n').entries()) if (PIECEWISE.test(line)) offenders.push(`${rel}:${i + 1}`);
    for (const m of text.matchAll(/\{"[^"]*&[a-z]+;[^"]*"\}/g)) entities.push(`${rel}: ${m[0].slice(0, 60)}`);
  }
  assert.deepEqual(offenders, [], '按英文语序拆分的计数模板（请改为整句规则）');
  assert.deepEqual(entities, [], '字面量中的 HTML 实体');
});

test('candidate tree: the zh-CN layout stylesheet is written and imported right after tailwind', { skip: !candidate }, () => {
  const css = fs.readFileSync(path.join(candidate, 'ui/src/zh-cn-layout.css'), 'utf8');
  assert.equal(css, fs.readFileSync(new URL('../overlays/zh-cn-layout.css', import.meta.url), 'utf8'));
  const index = fs.readFileSync(path.join(candidate, 'ui/src/index.css'), 'utf8');
  assert.ok(index.includes('@import "tailwindcss";\n@import "./zh-cn-layout.css";'));
  for (const token of ['--text-nano: 11px', '--text-micro: 12px', 'PingFang SC', 'word-break: keep-all', 'collection-toolbar-search', '#main-content > :last-child']) assert.ok(css.includes(token), token);
});

test('zh-CN catalogs carry decoded characters instead of HTML entities in translated values', () => {
  const dir = new URL('../catalogs/', import.meta.url);
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.zh-CN.json')) continue;
    const dict = JSON.parse(fs.readFileSync(new URL(name, dir), 'utf8'));
    for (const [key, value] of Object.entries(dict)) assert.ok(!/&(?:rarr|larr|gt|lt|middot|nbsp|times|hellip)[;]/.test(value), `${name}: ${key}`);
  }
});
