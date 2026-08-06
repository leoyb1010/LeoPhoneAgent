import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const CONFIG_PATH = resolve(__dirname, '../../fingerprint.config.cjs');

function loadConfigSourceSkips(env: Record<string, string> = {}): string[] {
  const script = `
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('EXPO_PUBLIC_')) delete process.env[k];
    }
    Object.assign(process.env, JSON.parse(process.argv[1]));
    delete require.cache[require.resolve(${JSON.stringify(CONFIG_PATH)})];
    const cfg = require(${JSON.stringify(CONFIG_PATH)});
    process.stdout.write(JSON.stringify(cfg.sourceSkips));
  `;
  const out = execFileSync(process.execPath, ['-e', script, JSON.stringify(env)], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return JSON.parse(out);
}

describe('fingerprint.config.cjs sourceSkips', () => {
  it('includes ExpoConfigVersions when EXPO_PUBLIC_XDT_OTA_SELFHOST=1', () => {
    const skips = loadConfigSourceSkips({ EXPO_PUBLIC_XDT_OTA_SELFHOST: '1' });
    expect(skips).toContain('ExpoConfigVersions');
    expect(skips).toContain('PackageJsonAndroidAndIosScriptsIfNotContainRun');
  });

  it('does not include ExpoConfigVersions without the self-host env', () => {
    const skips = loadConfigSourceSkips({});
    expect(skips).not.toContain('ExpoConfigVersions');
    expect(skips).toContain('PackageJsonAndroidAndIosScriptsIfNotContainRun');
  });

  it('ExpoConfigVersions is a valid @expo/fingerprint source skip', () => {
    let SourceSkips: Record<string, unknown>;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      SourceSkips = require('@expo/fingerprint').SourceSkips;
    } catch {
      return; // @expo/fingerprint not installed in test env — skip gracefully
    }
    expect(SourceSkips).toHaveProperty('ExpoConfigVersions');
  });
});
