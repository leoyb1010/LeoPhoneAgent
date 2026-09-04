import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('desktop exposes one new-task surface and keeps LeoAPI inside settings', () => {
  const app = readFileSync('src/components/app/AppContent.tsx', 'utf8');
  const titlebar = readFileSync('src/components/workbench/WorkbenchTitleBar.tsx', 'utf8');
  const launcher = readFileSync('electron/launcher/launcher.js', 'utf8');
  const sidebar = readFileSync('src/components/sidebar/view/Sidebar.tsx', 'utf8');
  const sidebarFooter = readFileSync('src/components/sidebar/view/subcomponents/SidebarFooter.tsx', 'utf8');
  const credentials = readFileSync(
    'src/components/settings/view/tabs/api-settings/CredentialsSettingsTab.tsx',
    'utf8',
  );

  assert.match(app, /activeTab === 'dashboard' && \(\s*<CommandBar/);
  assert.doesNotMatch(app, /DashboardView|NewTaskCard|LeoapiPanel/);
  assert.match(titlebar, /onStartNewTask/);
  assert.doesNotMatch(titlebar, /主控台|onOpenLeoapi|onOpenPalette/);
  assert.doesNotMatch(launcher, /cc-switch|openSwitch/);
  assert.doesNotMatch(sidebar, /setLocalTool\('leoapi'\)|onShowLeoapi/);
  assert.doesNotMatch(sidebarFooter, /Leoapi|onShowLeoapi/);
  assert.match(credentials, /<LeoapiRoutesSection \/>/);
});
