import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ForgePlatform } from '@electron-forge/shared-types';

/** 返回 Forge 目标平台对应的桌面第三方声明文件名。 */
export function desktopNoticeNameForPlatform(platform: ForgePlatform): string {
  switch (platform) {
    case 'win32':
      return 'desktop-win.txt';
    case 'darwin':
    case 'mas':
      return 'desktop-macos.txt';
    case 'linux':
      return 'desktop-linux.txt';
    default:
      throw new Error(`[forge:postPackage] unsupported notice platform: ${platform}`);
  }
}

/**
 * 在 macOS 产物目录里定位 .app bundle。
 *
 * Forge 的 postPackage hook 收到的 `opts.outputPaths` 是**平台产物目录**
 * (如 `out/xdt-maker-darwin-arm64`),.app bundle 在其内部;而单测 / 其它调用方
 * 可能直接把 `<App>.app` 当 buildPath 传进来。两种都要兼容:
 *   - buildPath 本身以 `.app` 结尾 → 直接用;
 *   - 否则扫描目录取唯一的 `*.app`;扫不到时按 productName 兜底拼 `xdt-maker.app`
 *     (交给上层 existsSync 报「packaged resources missing」)。
 */
function resolveMacAppBundle(buildPath: string): string {
  if (buildPath.endsWith('.app')) return buildPath;
  if (fs.existsSync(buildPath)) {
    const appDirs = fs.readdirSync(buildPath).filter((entry) => entry.endsWith('.app'));
    if (appDirs.length === 1) return path.join(buildPath, appDirs[0]);
  }
  return path.join(buildPath, 'xdt-maker.app');
}

/** 返回 electron-packager 产物内实际的 resources 目录。 */
export function packagedResourcesPath(buildPath: string, platform: ForgePlatform): string {
  return platform === 'darwin' || platform === 'mas'
    ? path.join(resolveMacAppBundle(buildPath), 'Contents', 'Resources')
    : path.join(buildPath, 'resources');
}

/** 把目标平台的精确声明覆盖进 packaged resources，makers 会原样打包。 */
export function stagePackagedThirdPartyNotices(
  buildPath: string,
  platform: ForgePlatform,
  noticesRoot = path.join(__dirname, '..', '..', 'docs', 'legal', 'notices'),
): string {
  const noticeName = desktopNoticeNameForPlatform(platform);
  const resourcesDir = packagedResourcesPath(buildPath, platform);
  if (!fs.existsSync(resourcesDir)) {
    throw new Error(`[forge:postPackage] packaged resources missing: ${resourcesDir}`);
  }

  const pairs = [
    [path.join(noticesRoot, noticeName), path.join(resourcesDir, 'THIRD-PARTY-NOTICES.txt')],
    [
      path.join(noticesRoot, noticeName.replace('.txt', '-restricted.txt')),
      path.join(resourcesDir, 'THIRD-PARTY-RESTRICTED.txt'),
    ],
  ] as const;
  for (const [source, destination] of pairs) {
    if (!fs.existsSync(source)) {
      throw new Error(
        `[forge:postPackage] third-party notice missing: ${source}; run pnpm licenses:generate`,
      );
    }
    fs.copyFileSync(source, destination);
  }
  return noticeName;
}
