import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { source, candidate, original, patched as patchedFile } from './helpers/patched.mjs';
const patches = JSON.parse(fs.readFileSync(new URL('../catalogs/task-dialog-system-labels.structural.json', import.meta.url)));
const modeFile = 'ui/src/lib/work-mode-meta.ts';
const assigneeFile = 'ui/src/lib/assignees.ts';
const patched = file => patchedFile(file, patches, { reversible: true });
function execute(text) {
  const js = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  new Function('exports', 'require', js)(exports, name => {
    assert.equal(name, 'lucide-react');
    return { ClipboardList: 'ClipboardList', Hammer: 'Hammer', MessageCircleQuestion: 'MessageCircleQuestion' };
  });
  return exports;
}
function check(read) {
  const modes = execute(read(modeFile));
  const upstreamModes = execute(original(modeFile));
  assert.equal(modes.workModeMetaFor('standard').label, '自动模式');
  const stripLabel = ({ label, ...mode }) => mode;
  assert.deepEqual(modes.workModeMetaList().map(stripLabel), upstreamModes.workModeMetaList().map(stripLabel));
  for (const value of ['standard', 'planning', 'ask', '', 'invalid', null]) {
    assert.equal(modes.isIssueWorkMode(value), upstreamModes.isIssueWorkMode(value));
    assert.equal(modes.nextWorkMode(value), upstreamModes.nextWorkMode(value));
    assert.equal(modes.titleForPendingWorkMode(value), upstreamModes.titleForPendingWorkMode(value));
  }
  const assignees = execute(read(assigneeFile));
  const upstreamAssignees = execute(original(assigneeFile));
  for (const userId of [null, undefined, '', 'local-board', 'custom-user-id', 'Me', '我']) {
    const options = assignees.currentUserAssigneeOption(userId);
    assert.deepEqual(options.map(({ label, ...option }) => option), upstreamAssignees.currentUserAssigneeOption(userId).map(({ label, ...option }) => option));
    if (userId) {
      assert.equal(options[0].label, '我');
      assert.equal(options[0].id, `user:${userId}`);
      assert.deepEqual(assignees.parseAssigneeValue(options[0].id), { assigneeAgentId: null, assigneeUserId: userId });
    }
  }
  for (const value of ['', 'agent:custom-agent-id', 'user:custom-user-id', 'old-agent-id', 'agent:', 'user:']) assert.deepEqual(assignees.parseAssigneeValue(value), upstreamAssignees.parseAssigneeValue(value));
  for (const name of ['Me', 'Auto mode', 'English Name', '李用户', '<b>Custom</b>']) {
    const labels = { 'custom-user-id': name };
    assert.equal(assignees.formatUserLabel('custom-user-id', labels), name);
    assert.equal(assignees.formatAssigneeUserLabel('custom-user-id', 'other-user', labels), name);
  }
}
test('task system labels localize while work modes, assignee identities and custom names stay exact', { skip: !source }, () => check(patched));
test('generated candidate has Chinese automatic mode and current-user picker option', { skip: !source || !candidate }, () => check(file => fs.readFileSync(path.join(candidate, file), 'utf8')));
