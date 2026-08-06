import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ForgePlatform } from '@electron-forge/shared-types';
import { afterEach, describe, expect, it } from 'vitest';
import {
  desktopNoticeNameForPlatform,
  packagedResourcesPath,
  stagePackagedThirdPartyNotices,
} from '../../../forge-third-party-notices';

const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdmaker-forge-notices-'));
  fixtures.push(root);
  const noticesRoot = path.join(root, 'docs', 'legal', 'notices');
  fs.mkdirSync(noticesRoot, { recursive: true });
  for (const platform of ['win', 'macos', 'linux']) {
    fs.writeFileSync(path.join(noticesRoot, `desktop-${platform}.txt`), `${platform} open\n`);
    fs.writeFileSync(
      path.join(noticesRoot, `desktop-${platform}-restricted.txt`),
      `${platform} restricted\n`,
    );
  }
  return { root, noticesRoot };
}

describe('Forge third-party notice staging', () => {
  it.each([
    ['win32', 'desktop-win.txt'],
    ['darwin', 'desktop-macos.txt'],
    ['mas', 'desktop-macos.txt'],
    ['linux', 'desktop-linux.txt'],
  ] as const)('maps %s to %s', (platform, expected) => {
    expect(desktopNoticeNameForPlatform(platform)).toBe(expected);
  });

  it.each(['darwin', 'mas'] as const)('stages %s notices under Contents/Resources', (platform) => {
    const fixture = createFixture();
    const buildPath = path.join(fixture.root, 'xdt-maker.app');
    const resourcesDir = path.join(buildPath, 'Contents', 'Resources');
    fs.mkdirSync(resourcesDir, { recursive: true });

    stagePackagedThirdPartyNotices(buildPath, platform, fixture.noticesRoot);

    expect(packagedResourcesPath(buildPath, platform)).toBe(resourcesDir);
    expect(fs.readFileSync(path.join(resourcesDir, 'THIRD-PARTY-NOTICES.txt'), 'utf8')).toBe(
      'macos open\n',
    );
  });

  it.each(['darwin', 'mas'] as const)(
    'stages %s notices when buildPath is the platform output dir (Forge outputPaths)',
    (platform) => {
      // 复现真实 postPackage:buildPath 是平台产物目录,.app 在其内部。
      const fixture = createFixture();
      const buildPath = path.join(fixture.root, 'xdt-maker-darwin-arm64');
      const resourcesDir = path.join(buildPath, 'xdt-maker.app', 'Contents', 'Resources');
      fs.mkdirSync(resourcesDir, { recursive: true });

      stagePackagedThirdPartyNotices(buildPath, platform, fixture.noticesRoot);

      expect(packagedResourcesPath(buildPath, platform)).toBe(resourcesDir);
      expect(fs.readFileSync(path.join(resourcesDir, 'THIRD-PARTY-NOTICES.txt'), 'utf8')).toBe(
        'macos open\n',
      );
    },
  );

  it.each([
    ['win32', 'win'],
    ['linux', 'linux'],
  ] as const)('stages %s notices under resources', (platform, noticePlatform) => {
    const fixture = createFixture();
    const buildPath = path.join(fixture.root, `xdt-maker-${platform}`);
    const resourcesDir = path.join(buildPath, 'resources');
    fs.mkdirSync(resourcesDir, { recursive: true });

    stagePackagedThirdPartyNotices(buildPath, platform as ForgePlatform, fixture.noticesRoot);

    expect(packagedResourcesPath(buildPath, platform as ForgePlatform)).toBe(resourcesDir);
    expect(fs.readFileSync(path.join(resourcesDir, 'THIRD-PARTY-NOTICES.txt'), 'utf8')).toBe(
      `${noticePlatform} open\n`,
    );
  });
});
