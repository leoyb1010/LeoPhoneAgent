import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
const source = process.env.PAPERCLIP_SOURCE;
const lock = JSON.parse(fs.readFileSync(new URL('../upstream.lock.json', import.meta.url)));
const patches = fs.readdirSync(new URL('../catalogs/', import.meta.url)).filter(f => f.endsWith('.structural.json')).sort()
  .flatMap(f => JSON.parse(fs.readFileSync(new URL('../catalogs/' + f, import.meta.url))));
for (const suffix of ['', '.production']) test(`anonymous sidebar name is neutral Chinese; real names stay intact (${suffix || 'normal'})`, { skip: !source }, () => {
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(), lock.commit);
  const file = `ui/src/components/SidebarAccountMenu${suffix}.tsx`;
  let text = execFileSync('git', ['show', `HEAD:${file}`], { cwd: source, encoding: 'utf8' });
  for (const patch of patches.filter(p => p.file === file)) {
    assert.equal(text.split(patch.from).length - 1, patch.expected ?? 1);
    text = text.split(patch.from).join(patch.to);
  }
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
