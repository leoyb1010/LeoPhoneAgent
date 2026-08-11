import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('settings host remains mounted at app level on dashboard and fleet routes', () => {
  const appContent = readFileSync('src/components/app/AppContent.tsx', 'utf8');
  const sidebarModals = readFileSync('src/components/sidebar/view/subcomponents/SidebarModals.tsx', 'utf8');

  assert.match(appContent, /<SettingsHost\s/);
  assert.doesNotMatch(sidebarModals, /showSettings/);
});
