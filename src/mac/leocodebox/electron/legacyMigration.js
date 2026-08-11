import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const LEGACY_LABEL = 'com.leoyuan.cloudcli';

export function isConflictingLegacyLaunchAgent(contents) {
  const text = String(contents || '');
  return text.includes(LEGACY_LABEL)
    && text.includes('@cloudcli-ai/cloudcli')
    && (text.includes('<string>38473</string>') || text.includes('SERVER_PORT=38473'));
}

export async function disableConflictingLegacyLaunchAgent({
  platform = process.platform,
  homeDir = os.homedir(),
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  fsApi = fs,
  execFileImpl = execFileAsync,
} = {}) {
  if (platform !== 'darwin') return { migrated: false, reason: 'unsupported-platform' };

  const sourcePath = path.join(homeDir, 'Library', 'LaunchAgents', `${LEGACY_LABEL}.plist`);
  let contents = '';
  try {
    contents = await fsApi.readFile(sourcePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { migrated: false, reason: 'not-found' };
    throw error;
  }
  if (!isConflictingLegacyLaunchAgent(contents)) {
    return { migrated: false, reason: 'not-conflicting' };
  }

  if (uid !== null) {
    await execFileImpl('/bin/launchctl', ['bootout', `gui/${uid}`, sourcePath]).catch(() => undefined);
    await execFileImpl('/bin/launchctl', ['disable', `gui/${uid}/${LEGACY_LABEL}`]).catch(() => undefined);
  }

  let disabledPath = `${sourcePath}.disabled-by-leocodebox`;
  try {
    await fsApi.access(disabledPath);
    disabledPath = `${disabledPath}-${Date.now()}`;
  } catch {
    // The stable backup name is available.
  }
  await fsApi.rename(sourcePath, disabledPath);
  return { migrated: true, sourcePath, disabledPath };
}
