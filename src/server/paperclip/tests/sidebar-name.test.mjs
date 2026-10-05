import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { source, original, applyPatches } from './helpers/patched.mjs';
import { loadStructuralPatches } from '../scripts/structural-patches.mjs';
const lock = JSON.parse(fs.readFileSync(new URL('../upstream.lock.json', import.meta.url)));
// 1.1.6：与 localize.mjs 相同，按 catalogs/order.json 的显式顺序加载。
const patches = loadStructuralPatches();
for (const suffix of ['', '.production']) test(`anonymous sidebar name is neutral Chinese; real names stay intact (${suffix || 'normal'})`, { skip: !source }, () => {
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(), lock.commit);
  const file = `ui/src/components/SidebarAccountMenu${suffix}.tsx`;
  const text = applyPatches(original(file), patches, file);
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let expression;
  function visit(node) { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'displayName') expression = node.initializer.getText(ast); ts.forEachChild(node, visit); }
  visit(ast); assert.ok(expression);
  // Execute the exact reviewed initializer rather than a duplicate test-only helper.
  const display = new Function('session', `return (${expression});`);
  for (const session of [null, undefined, { user: {} }, { user: { name: '' } }, { user: { name: '   ' } }]) assert.equal(display(session), '用户');
  for (const name of ['Board', 'Admin', 'English Name', '李用户', '<b>User text</b>']) assert.equal(display({ user: { name } }), name);
  // Retain upstream whitespace normalization, not an extra translation of user data.
  assert.equal(display({ user: { name: '  Board  ' } }), 'Board');
});
