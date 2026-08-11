import fs from 'node:fs';
import path from 'node:path';

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export function readProductVersion(appRoot, fallbackVersion = '0.0.0') {
  try {
    const packagePath = path.join(appRoot, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    const version = typeof packageJson.version === 'string' ? packageJson.version.trim() : '';
    if (SEMVER_PATTERN.test(version)) return version;
  } catch {
    // Fall through to Electron's version when package metadata is unavailable.
  }

  return fallbackVersion;
}
