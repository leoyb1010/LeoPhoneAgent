/**
 * E4D 毛玻璃 vibrancy 配置(R1 audit,用户裁决透壁纸 2026-07-17)。
 * 仅 CINDY family 启用 macOS vibrancy + 透明底(透出桌面壁纸);其他 family 恢复
 * 不透明。Windows 11 CINDY family 启用 Electron backgroundMaterial;Windows 10/Linux
 * 回退不透明。
 */
import { createLogger } from './logger.js';

const log = createLogger('vibrancyConfig');

export type WindowsBackdropMaterial = 'acrylic' | 'mica' | 'tabbed' | 'none';

export interface VibrancyConfig {
  vibrancy: string | null;
  backgroundColor: string;
  backgroundMaterial?: WindowsBackdropMaterial;
}

export interface ResolveVibrancyConfigOptions {
  getSystemVersion?: () => string;
}

const VALID_BACKDROP_MATERIALS = new Set<WindowsBackdropMaterial>([
  'acrylic',
  'mica',
  'tabbed',
  'none',
]);

function readWindowsSystemVersion(options?: ResolveVibrancyConfigOptions): string | null {
  try {
    if (options?.getSystemVersion) return options.getSystemVersion();
    const getSystemVersion = (process as NodeJS.Process & { getSystemVersion?: () => string })
      .getSystemVersion;
    return typeof getSystemVersion === 'function' ? getSystemVersion() : null;
  } catch {
    return null;
  }
}

function parseWindowsBuild(systemVersion: string | null): number | null {
  if (!systemVersion) return null;
  const parts = systemVersion.trim().split('.');
  if (parts.length < 3) return null;
  const build = Number.parseInt(parts[2] ?? '', 10);
  return Number.isFinite(build) ? build : null;
}

function isWindows11(options?: ResolveVibrancyConfigOptions): boolean {
  const build = parseWindowsBuild(readWindowsSystemVersion(options));
  return build !== null && build >= 22000;
}

function resolveBackdropMaterial(): WindowsBackdropMaterial {
  const raw = process.env.XDT_BACKDROP_MATERIAL;
  if (!raw) return 'acrylic';
  if (VALID_BACKDROP_MATERIALS.has(raw as WindowsBackdropMaterial)) {
    return raw as WindowsBackdropMaterial;
  }
  log.warn(`Invalid XDT_BACKDROP_MATERIAL '${raw}', falling back to acrylic.`);
  return 'acrylic';
}

export function resolveVibrancyConfig(
  familyId: string,
  isDark: boolean,
  platform: string,
  options?: ResolveVibrancyConfigOptions,
): VibrancyConfig {
  const isCindy = familyId === 'cindy';
  const opaqueBg = isDark ? '#1f1f1e' : '#f8f8f6';
  if (platform === 'darwin') {
    // 材质 A/B 旋钮(dev 调参用):XDT_VIBRANCY_MATERIAL=sidebar|hud|under-window|fullscreen-ui|
    // popover|menu|none('none'=无材质纯透明,壁纸不模糊直透)。缺省 'hud'(用户实测定稿,2026-07-19 回写)。
    const material = process.env.XDT_VIBRANCY_MATERIAL || 'hud';
    return {
      vibrancy: isCindy && material !== 'none' ? material : null,
      backgroundColor: isCindy ? '#00000000' : opaqueBg,
    };
  }
  if (platform === 'win32') {
    if (isCindy && isWindows11(options)) {
      return {
        vibrancy: null,
        backgroundColor: '#00000000',
        backgroundMaterial: resolveBackdropMaterial(),
      };
    }
    return { vibrancy: null, backgroundColor: opaqueBg, backgroundMaterial: 'none' };
  }
  // Linux:无 vibrancy,不透明底
  return { vibrancy: null, backgroundColor: opaqueBg };
}
