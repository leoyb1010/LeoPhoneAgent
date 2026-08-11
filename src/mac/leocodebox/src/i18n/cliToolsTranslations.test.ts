import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const locales = ['de', 'en', 'fr', 'it', 'ja', 'ko', 'ru', 'tr', 'zh-CN', 'zh-TW'];
const requiredKeys = [
  'title',
  'refresh',
  'versionCheck',
  'updateAvailable',
  'latest',
  'notRunnable',
  'notInstalled',
  'update',
  'install',
  'loadFailed',
  'actionFailed',
];

test('every supported locale includes CLI tool status translations', async () => {
  for (const locale of locales) {
    const file = path.resolve(`src/i18n/locales/${locale}/settings.json`);
    const settings = JSON.parse(await fs.readFile(file, 'utf8'));
    for (const key of requiredKeys) {
      assert.equal(
        typeof settings.agents?.cliTools?.[key],
        'string',
        `${locale} is missing settings.agents.cliTools.${key}`,
      );
    }
  }
});

const browserUseRequiredKeys = [
  'title',
  'description',
  'enable',
  'enableDescription',
  'status',
  'checking',
  'installed',
  'notInstalled',
  'available',
  'needsInstall',
  'disabled',
  'runtimeRequired',
  'install',
  'installing',
  'loadSettingsError',
  'loadStatusError',
  'saveError',
  'installError',
  'runtimeDefault',
  'runtimeInstallBoth',
  'runtimeChromiumMissing',
  'runtimeNotReady',
  'runtimeReady',
];

test('every supported locale includes browser runtime settings translations', async () => {
  for (const locale of locales) {
    const file = path.resolve(`src/i18n/locales/${locale}/settings.json`);
    const settings = JSON.parse(await fs.readFile(file, 'utf8'));
    for (const key of browserUseRequiredKeys) {
      assert.equal(
        typeof settings.browserUse?.[key],
        'string',
        `${locale} is missing settings.browserUse.${key}`,
      );
    }
  }
});

test('every supported locale includes the session audit navigation and copy', async () => {
  for (const locale of locales) {
    const file = path.resolve(`src/i18n/locales/${locale}/common.json`);
    const common = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(typeof common.tabs?.audit, 'string', `${locale} is missing common.tabs.audit`);
    for (const key of ['title', 'description', 'export', 'search', 'allProjects', 'allProviders', 'toolCalls', 'errors', 'permissions', 'tokenUsage', 'replayError']) {
      assert.equal(typeof common.audit?.[key], 'string', `${locale} is missing common.audit.${key}`);
    }
  }
});

test('every supported locale includes workspace, appearance, auth, and sidebar shell translations', async () => {
  for (const locale of locales) {
    const [common, settings, auth, sidebar] = await Promise.all([
      fs.readFile(path.resolve(`src/i18n/locales/${locale}/common.json`), 'utf8').then(JSON.parse),
      fs.readFile(path.resolve(`src/i18n/locales/${locale}/settings.json`), 'utf8').then(JSON.parse),
      fs.readFile(path.resolve(`src/i18n/locales/${locale}/auth.json`), 'utf8').then(JSON.parse),
      fs.readFile(path.resolve(`src/i18n/locales/${locale}/sidebar.json`), 'utf8').then(JSON.parse),
    ]);
    for (const key of ['navigationLabel', 'projects', 'serviceHealthy', 'tasksRunning', 'autoSave']) {
      assert.equal(typeof common.workspaceShell?.[key], 'string', `${locale} is missing common.workspaceShell.${key}`);
    }
    for (const key of ['loadingWorkspace', 'stepSelectProject', 'running', 'processingCurrent', 'currentRun', 'workingDirectory']) {
      assert.equal(typeof common.workspaceRuntime?.[key], 'string', `${locale} is missing common.workspaceRuntime.${key}`);
    }
    for (const key of ['regionTitle', 'regionDescription', 'details', 'reload']) {
      assert.equal(typeof common.errorBoundary?.[key], 'string', `${locale} is missing common.errorBoundary.${key}`);
    }
    for (const key of ['agentDefaultsTitle', 'defaultAgent', 'defaultModel', 'defaultPermission', 'density', 'reduceMotion', 'theme']) {
      assert.equal(typeof settings.appearanceSettings?.workspace?.[key], 'string', `${locale} is missing settings.appearanceSettings.workspace.${key}`);
    }
    for (const key of ['loginFooter', 'localServiceTitle', 'reload', 'localAuthInitFailed']) {
      assert.equal(typeof auth.localDesktop?.[key], 'string', `${locale} is missing auth.localDesktop.${key}`);
    }
    assert.equal(typeof auth.providerLogin?.loadingTerminal, 'string', `${locale} is missing auth.providerLogin.loadingTerminal`);
    for (const key of ['localLog', 'settings', 'localMode', 'leoapiSwitch', 'loadingSettings']) {
      assert.equal(typeof sidebar.localUi?.[key], 'string', `${locale} is missing sidebar.localUi.${key}`);
    }
  }
});

test('every supported locale includes command palette and updater translations', async () => {
  for (const locale of locales) {
    const [common, settings, auth] = await Promise.all([
      fs.readFile(path.resolve(`src/i18n/locales/${locale}/common.json`), 'utf8').then(JSON.parse),
      fs.readFile(path.resolve(`src/i18n/locales/${locale}/settings.json`), 'utf8').then(JSON.parse),
      fs.readFile(path.resolve(`src/i18n/locales/${locale}/auth.json`), 'utf8').then(JSON.parse),
    ]);
    for (const key of ['title', 'searchAll', 'actions', 'sessions', 'startChat', 'openSettings', 'browseFiles', 'switchBranch']) {
      assert.equal(typeof common.commandPalette?.[key], 'string', `${locale} is missing common.commandPalette.${key}`);
    }
    for (const key of ['updates', 'checking', 'available', 'downloaded', 'tokenLabel', 'check', 'download', 'restartInstall', 'modalTitle', 'recheck']) {
      assert.equal(typeof settings.about?.[key], 'string', `${locale} is missing settings.about.${key}`);
    }
    assert.equal(typeof auth.localDesktop?.mode, 'string', `${locale} is missing auth.localDesktop.mode`);
  }
});
