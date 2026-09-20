import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('legacy SettingsHost is opened from the 2.0 settings page, not a second sidebar', () => {
  const settingsPage = readFileSync('src/v2/pages.tsx', 'utf8');
  const app = readFileSync('src/App.tsx', 'utf8');

  assert.match(settingsPage, /LegacySettings/);
  assert.match(settingsPage, /更多设置/);
  assert.match(settingsPage, /再看一次/);
  assert.match(app, /App2/);
  assert.doesNotMatch(app, /showSettings/);
  assert.doesNotMatch(app, /WhatsNewModal/);
});
