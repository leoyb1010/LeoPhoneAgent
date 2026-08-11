import assert from 'node:assert/strict';
import test from 'node:test';

import { browserUseService, getMcpRegistration } from '@/modules/browser-use/browser-use.service.js';

test('browser monitor list starts empty without agent sessions', async () => {
  const sessions = await browserUseService.listSessions();

  assert.deepEqual(sessions, []);
});

test('packaged MCP registration forces the Electron executable into Node mode', () => {
  const registration = getMcpRegistration();

  assert.equal(typeof registration.env.LEOCODEBOX_BROWSER_USE_MCP_TOKEN_FILE, 'string');
  assert.equal(registration.env.LEOCODEBOX_BROWSER_USE_MCP_TOKEN, undefined);
  if (registration.command === process.execPath && registration.args[0]?.endsWith('browser-use-mcp.js')) {
    assert.equal(registration.env.ELECTRON_RUN_AS_NODE, '1');
  }
});
