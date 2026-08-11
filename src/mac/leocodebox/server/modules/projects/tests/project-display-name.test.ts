import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  friendlyProjectLeafName,
  isJunkProjectPath,
} from '../services/projects-with-sessions-fetch.service.js';

test('humanizes encoded macOS user paths without depending on the original machine username', () => {
  assert.equal(friendlyProjectLeafName('users-alice-documents-my-project'), 'my project');
  assert.equal(friendlyProjectLeafName('users-bob-workspace-client-app'), 'client app');
  assert.equal(friendlyProjectLeafName('users-charlie-library-application-support-demo'), 'demo');
});

test('filters machine-level and application-owned session noise from the project list', () => {
  const homeDir = '/Users/alice';

  assert.equal(isJunkProjectPath(homeDir, homeDir), true);
  assert.equal(isJunkProjectPath(`${homeDir}/.claude-mem/observer-sessions`, homeDir), true);
  assert.equal(isJunkProjectPath('/Applications/Open Design.app/Contents/Resources/app/prebundled', homeDir), true);
  assert.equal(
    isJunkProjectPath(`${homeDir}/Library/Application Support/io.github.demo`, homeDir),
    true,
  );
  assert.equal(isJunkProjectPath(`${homeDir}/Library/Mobile Documents/client-app`, homeDir), false);
  assert.equal(isJunkProjectPath(`${homeDir}/Documents/Codex/2026-07-07/temporary-run`, homeDir), true);
  assert.equal(isJunkProjectPath(`${homeDir}/Documents/client-app`, homeDir), false);
});

test('keeps a real git repository directly below a date-stamped folder', () => {
  const home = '/Users/tester';
  const projectPath = path.join(home, 'src', '2026-07-09', 'real-repo');
  assert.equal(
    isJunkProjectPath(projectPath, home, (candidate) => candidate === path.join(projectPath, '.git')),
    false,
  );
});
