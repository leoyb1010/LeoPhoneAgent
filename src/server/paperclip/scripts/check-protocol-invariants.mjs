#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import assert from 'node:assert/strict';
const root = path.resolve(process.argv[2] || '.upstream');
const state = JSON.parse(fs.readFileSync(path.join(root, '.leophone-zh-overlay.json')));
const jsxAttributes = new Set(['type', 'name', 'id', 'value', 'method', 'target', 'autoComplete', 'inputMode']);
const dataFields = new Set(['status', 'method', 'adapterType', 'scopeType', 'priority', 'companyId', 'agentId', 'issueId']);
function literals(source, file) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const result = [];
  function walk(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const p = node.parent;
      const name = p.name?.getText(ast).replace(/^['"]|['"]$/g, '');
      if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(p.operatorToken.kind)) result.push(`comparison:${node.text}`);
      if (ts.isJsxAttribute(p) && jsxAttributes.has(name) && (!["name", "value"].includes(name) || /^(?:input|option|select|textarea|button|Input|Textarea|Select|SelectItem|Tabs|TabsTrigger|TabsContent|RadioGroup|RadioGroupItem|ToggleGroup|ToggleGroupItem|Checkbox|FormField|Controller)$/.test(p.parent.parent.tagName?.getText(ast) ?? ""))) result.push(`attribute:${name}:${node.text}`);
      if (ts.isPropertyAssignment(p) && p.initializer === node && dataFields.has(name) && (/^[a-z][A-Za-z0-9_-]*$/.test(node.text) || /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(node.text))) result.push(`data:${name}:${node.text}`);
      if (ts.isCallExpression(p) && p.arguments[0] === node) {
        const called = p.expression.getText(ast);
        if (/^(?:api\.(?:get|post|put|patch|delete|postForm|request)|navigate|replace|redirect)$/.test(called) && node.text.startsWith('/')) result.push(`route:${called}:${node.text}`);
      }
    }
    ts.forEachChild(node, walk);
  }
  walk(ast);
  return result.sort();
}
const exceptions = JSON.parse(fs.readFileSync(new URL("../catalogs/protocol-audit-exceptions.json", import.meta.url)));
let inspected = 0;
const reviewedExceptions = [];
for (const file of Object.keys(state.files).filter(f => /\.(tsx?|jsx?)$/.test(f))) {
  let original;
  try { original = execFileSync('git', ['show', `HEAD:${file}`], { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 20_000_000 }); } catch { continue; }
  const current = fs.readFileSync(path.join(root, file), 'utf8');
  const before = literals(original, file); const after = literals(current, file);
  // Added stable explicit option values are allowed; every original literal
  // must remain with its original multiplicity. Display-only strings are not
  // used as a proxy for protocol identity.
  const available = new Map(); for (const value of after) available.set(value, (available.get(value) ?? 0) + 1);
  const lost = [];
  for (const value of before) { const n = available.get(value) ?? 0; if (n < 1) lost.push(value); else available.set(value, n - 1); }
  const unreviewed = lost.filter(literal => {
    const exception = exceptions.find(e => e.file === file && e.literal === literal);
    if (!exception) return true;
    assert.ok(current.includes(exception.requiredReplacement), `已审阅例外的替代逻辑缺失：${file}`);
    reviewedExceptions.push(exception);
    return false;
  });
  assert.deepEqual(unreviewed, [], `协议/表单标识被改写：${file}`);
  inspected++;
}
console.log(JSON.stringify({ passed: true, inspectedFiles: inspected, reviewedExceptions, checks: ['stable native/control form attribute literals', 'state/API field literals', 'API/navigation route literals', 'comparison literals'], limitation: 'Targeted static invariants, not complete semantic equivalence' }, null, 2));
