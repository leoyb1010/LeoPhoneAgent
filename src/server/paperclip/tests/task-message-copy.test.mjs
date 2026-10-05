import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { source, candidate, original as pinned } from './helpers/patched.mjs';
const [patch] = JSON.parse(fs.readFileSync(new URL('../catalogs/task-message-copy.structural.json', import.meta.url)));
const original = () => pinned(patch.file);
function check(text) {
  const ast = ts.createSourceFile(patch.file, text, ts.ScriptTarget.Latest, true);
  let label;
  let click;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'label') label = node.initializer.getText(ast);
    if (ts.isJsxAttribute(node) && node.name.getText(ast) === 'onClick') click = node.initializer.expression.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(label);
  const display = new Function('copied', 'failed', `return (${label});`);
  assert.equal(display(false, false), '复制消息');
  assert.equal(display(false, true), '复制消息失败');
  assert.equal(display(true, false), '已复制');
  assert.equal(display(true, true), '已复制');
  assert.ok(text.includes('title={label}'));
  assert.ok(text.includes('aria-label={label}'));
  assert.ok(text.includes('useCopyAction(2000)'));
  assert.ok(text.includes('activeVote={feedback.activeVote}'));
  assert.ok(text.includes('onVote={feedback.onVote}'));
  assert.ok(click);
  for (const content of ['LEOPHONE_SERVER_OK', 'Copy message', '复制消息', '<b>raw output</b>', '  whitespace\nline two\n']) {
    const received = [];
    const onClick = new Function('copy', 'copyText', `return (${click});`)(value => received.push(value), content);
    onClick();
    assert.deepEqual(received, [content], 'copy handler preserves the exact comment/output content');
  }
}
test('message copy action and feedback are Chinese while copied comment contents stay exact', { skip: !source }, () => {
  const text = original();
  assert.equal(text.split(patch.from).length - 1, patch.expected);
  const localized = text.split(patch.from).join(patch.to);
  assert.equal(localized.split(patch.to).join(patch.from), text, 'no changes outside copy-action label');
  check(localized);
});
test('generated candidate contains the Chinese message copy action and success/failure feedback', { skip: !source || !candidate }, () => check(fs.readFileSync(path.join(candidate, patch.file), 'utf8')));
