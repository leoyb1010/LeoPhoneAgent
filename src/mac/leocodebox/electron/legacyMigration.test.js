import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { disableConflictingLegacyLaunchAgent, isConflictingLegacyLaunchAgent } from './legacyMigration.js';

const legacyPlist = `<?xml version="1.0"?><plist><dict>
<key>Label</key><string>com.leoyuan.cloudcli</string>
<key>ProgramArguments</key><array><string>/Users/test/.local/lib/node_modules/@cloudcli-ai/cloudcli/dist-server/server/cli.js</string></array>
<key>SERVER_PORT</key><string>38473</string>
</dict></plist>`;

test('legacy migration only recognizes the exact conflicting CloudCLI launch agent', () => {
  assert.equal(isConflictingLegacyLaunchAgent(legacyPlist), true);
  assert.equal(isConflictingLegacyLaunchAgent(legacyPlist.replace('38473', '3001')), false);
  assert.equal(isConflictingLegacyLaunchAgent(legacyPlist.replace('@cloudcli-ai/cloudcli', 'other-product')), false);
});

test('legacy migration unloads and preserves the old plist as a disabled backup', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'leocodebox-legacy-agent-'));
  const launchAgents = path.join(homeDir, 'Library', 'LaunchAgents');
  const sourcePath = path.join(launchAgents, 'com.leoyuan.cloudcli.plist');
  await fs.mkdir(launchAgents, { recursive: true });
  await fs.writeFile(sourcePath, legacyPlist);
  const calls = [];

  const result = await disableConflictingLegacyLaunchAgent({
    homeDir,
    uid: 501,
    execFileImpl: async (command, args) => { calls.push([command, args]); },
  });

  assert.equal(result.migrated, true);
  await assert.rejects(fs.access(sourcePath));
  assert.equal(await fs.readFile(result.disabledPath, 'utf8'), legacyPlist);
  assert.deepEqual(calls.map((call) => call[1][0]), ['bootout', 'disable']);
});
