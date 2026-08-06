/**
 * git-safety-settings-store —— Git safety workflow machine settings.
 *
 * File: <userData>/git-safety-settings.json
 *   { "autoSnapshotEnabled": true }
 *
 * Default off: automatic commits must be an explicit opt-in. The override file
 * stores only customized fields, so future default changes can flow to users
 * who never changed the setting.
 */

import { app } from 'electron';
import path from 'node:path';

import { desktopMakerLogger } from './logger-adapter.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from './override-settings-file.js';

const log = desktopMakerLogger.child('git-safety-settings-store');

export interface GitSafetySettings {
  autoSnapshotEnabled: boolean;
}

const DEFAULTS: GitSafetySettings = {
  autoSnapshotEnabled: false,
};

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'git-safety-settings.json');
}

function normalize(raw: unknown): GitSafetySettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    autoSnapshotEnabled:
      typeof r.autoSnapshotEnabled === 'boolean'
        ? r.autoSnapshotEnabled
        : DEFAULTS.autoSnapshotEnabled,
  };
}

const store = createOverrideSettingsFile<GitSafetySettings>({
  filePath: settingsFilePath,
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'git safety',
});

export function readGitSafetySettings(): GitSafetySettings {
  return store.read();
}

export function readGitSafetySettingsState(): OverrideSettingsState<GitSafetySettings> {
  return store.readState();
}

export function writeGitSafetyAutoSnapshotEnabled(
  autoSnapshotEnabled: boolean,
): OverrideSettingsState<GitSafetySettings> {
  store.writePatch({ autoSnapshotEnabled });
  log.info('git safety setting written', { autoSnapshotEnabled });
  return store.readState();
}

export function resetGitSafetySettings(): GitSafetySettings {
  return store.reset();
}

export const __testing = { normalize };
