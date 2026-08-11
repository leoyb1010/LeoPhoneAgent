import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDiagnosticsReport, redactHomePaths } from '../diagnostics.service.js';
import { normalizeProvider, sanitizeProvider } from '../provider-store.service.js';

test('diagnostics report never contains plaintext provider secrets', () => {
  const secret = 'sk-super-secret-key-abcdef123456';
  const provider = normalizeProvider({
    target: 'claude',
    name: '家里光猫',
    baseUrl: 'https://api.example.com/v1',
    apiKey: secret,
  });

  const report = buildDiagnosticsReport({
    appVersion: '1.40.0',
    cliTools: [{ id: 'claude', installed: true, executablePath: '/Users/leoyuan/.local/bin/claude' }],
    switchProviders: [sanitizeProvider(provider)],
    activeByTarget: { claude: provider.id },
  }, '/Users/leoyuan');

  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes(secret), 'plaintext API key leaked into diagnostics');
  assert.ok(!serialized.includes('/Users/leoyuan'), 'home directory leaked into diagnostics');
  assert.ok(serialized.includes('~/.local/bin/claude'), 'home paths should collapse to ~');
  assert.ok(serialized.includes('hasApiKey'), 'sanitized provider shape expected');
});

test('redactHomePaths collapses every occurrence of the home directory', () => {
  const input = {
    a: '/home/leo/project',
    nested: { logs: ['/home/leo/.leocodebox/x', 'no-path-here'] },
  };
  const output = redactHomePaths(input, '/home/leo');
  assert.equal(output.a, '~/project');
  assert.deepEqual(output.nested.logs, ['~/.leocodebox/x', 'no-path-here']);
});
