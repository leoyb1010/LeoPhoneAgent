import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DesktopUpdaterController,
  LEGACY_UPDATE_BRIDGE_VERSION,
  clearUpdaterTokenEnvironment,
} from './updater.js';
import { getUpdateMetadataVersion } from './versionBridge.js';

class FakeUpdater extends EventEmitter {
  setFeedURL(options) {
    this.feed = options;
  }

  async checkForUpdates() {
    this.emit('update-available', { version: '1.1.3', releaseName: 'Local agent workspace' });
  }

  async downloadUpdate() {
    this.emit('download-progress', { percent: 54.4 });
    this.emit('update-downloaded', { version: '1.1.3' });
  }

  quitAndInstall() {
    this.didInstall = true;
  }
}

const fakeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${value}`),
  decryptString: (value) => value.toString().replace(/^encrypted:/, ''),
};

test('updater credentials are removed from inherited child-process environments', () => {
  const environment = {
    GH_TOKEN: 'legacy-token',
    GITHUB_TOKEN: 'github-token',
    PATH: '/usr/bin',
  };
  clearUpdaterTokenEnvironment(environment);
  assert.deepEqual(environment, { PATH: '/usr/bin' });
});

test('private updater requires a credential and never exposes the saved token in state', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leocodebox-updater-'));
  const updater = new FakeUpdater();
  const controller = new DesktopUpdaterController({
    appVersion: '1.1.2',
    isPackaged: true,
    settingsPath: path.join(root, 'updater.json'),
    updater,
    storage: fakeStorage,
  });
  controller.genericFeedUrl = '';

  try {
    await controller.load();
    assert.equal(controller.getState().status, 'authentication-required');

    const state = await controller.saveGithubToken('github-secret');
    assert.equal(state.configured, true);
    assert.equal(JSON.stringify(state).includes('github-secret'), false);
    assert.equal(updater.feed.provider, 'github');
    assert.equal(updater.feed.private, true);

    await controller.checkForUpdates();
    assert.equal(controller.getState().status, 'available');
    assert.equal(controller.getState().latestVersion, '1.1.3');

    await controller.downloadUpdate();
    assert.equal(controller.getState().status, 'downloaded');
    assert.equal(controller.getState().progress, 100);

    let prepared = false;
    await controller.installUpdate(async () => {
      prepared = true;
    });
    assert.equal(prepared, true);
    assert.equal(updater.didInstall, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('packaged clients use the public release feed without credentials by default', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leocodebox-updater-public-'));
  const updater = new FakeUpdater();
  const controller = new DesktopUpdaterController({ appVersion: '1.39.0', isPackaged: true, settingsPath: path.join(root, 'updater.json'), updater, storage: fakeStorage });
  try {
    const state = await controller.load();
    assert.equal(state.configured, true);
    assert.equal(state.credentialRequired, false);
    assert.equal(updater.feed.provider, 'generic');
    assert.match(updater.feed.url, /leocodebox-updates\/releases\/latest\/download/);
    assert.equal(updater.autoInstallOnAppQuit, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('historical version reset bridge does not loop on 1.1.3', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leocodebox-updater-bridge-'));
  const updater = new FakeUpdater();
  const controller = new DesktopUpdaterController({
    appVersion: '1.1.3',
    isPackaged: true,
    settingsPath: path.join(root, 'updater.json'),
    updater,
    storage: fakeStorage,
  });

  try {
    await controller.load();
    assert.equal(await updater.isUpdateSupported({ version: LEGACY_UPDATE_BRIDGE_VERSION }), false);
    assert.equal(await updater.isUpdateSupported({ version: '1.38.0' }), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('current releases use normal semver updates', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leocodebox-updater-current-'));
  const updater = new FakeUpdater();
  const controller = new DesktopUpdaterController({
    appVersion: '1.38.0',
    isPackaged: true,
    settingsPath: path.join(root, 'updater.json'),
    updater,
    storage: fakeStorage,
  });

  try {
    await controller.load();
    assert.equal(typeof updater.isUpdateSupported, 'undefined');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('release metadata preserves the current product version', () => {
  assert.equal(getUpdateMetadataVersion('1.38.0'), '1.38.0');
});
