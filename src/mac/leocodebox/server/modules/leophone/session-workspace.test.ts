import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { expandSessionCwd, sessionCwdAllowed, workspaceFromRow } from './session-workspace.js';

test('会话目录把 ~ 扩成本机家目录', () => {
  const home = '/Users/leo';
  assert.equal(expandSessionCwd('~', home), home);
  assert.equal(expandSessionCwd('~/src/app', home), path.join(home, 'src/app'));
  assert.equal(expandSessionCwd('/tmp/work', home), '/tmp/work');
  assert.equal(expandSessionCwd('  ', home), home);
});

test('项目行折成文件树要的 projectId 和绝对路径', () => {
  const view = workspaceFromRow({
    project_id: 'proj_1',
    project_path: '/tmp/leo-work',
    custom_project_name: null,
  });
  assert.equal(view.projectId, 'proj_1');
  assert.equal(view.fullPath, '/tmp/leo-work');
  assert.equal(view.displayName, 'leo-work');
  assert.notEqual(view.projectId.startsWith('harness-'), true);
});

test('expandSessionCwd 默认家目录就是 os.homedir', () => {
  assert.equal(expandSessionCwd('~'), os.homedir());
});

test('会话工作区允许 /tmp 下的目录,拦住系统根', () => {
  assert.equal(sessionCwdAllowed('/tmp/leo-work'), true);
  assert.equal(sessionCwdAllowed('/'), false);
  assert.equal(sessionCwdAllowed('/etc/passwd'), false);
});
