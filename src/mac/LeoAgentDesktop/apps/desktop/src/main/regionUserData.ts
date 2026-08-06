/**
 * regionUserData — packaged 构建按区域切换 Electron userData 目录(同机双装)。
 *
 * 背景:cn / global 是两个可同机并存的系统身份(appId / exe / 安装目录已按
 * 区域派生),但 Electron 默认 userData 目录由 package.json productName('Cindy')
 * 派生,两个区域的包会共用同一目录——数据库 / 登录态 / 单实例锁全部串台。
 * 因此 global 构建在 main 入口最早期(initLogger、crashReporter、单实例锁、
 * 一切 userData 读取之前)把 userData 切到区域目录(%APPDATA%\CindyGlobal /
 * ~/Library/Application Support/CindyGlobal),与 cn 版彻底分库。
 *
 * 语义边界:
 *  - cn 构建的区域目录名 = productName 默认派生目录 → 返回 null,零改动,
 *    保持 Electron 原生行为(线上 cn 包与历史行为完全一致)。
 *  - dev(非 packaged)永远返回 null:dev 的隔离语义由 --isolated /
 *    XDT_USER_DATA_DIR(devCliFlags)承载,不与区域身份耦合。
 *  - 命令行显式传了 Chromium 原生 `--user-data-dir` 时返回 null,尊重调用方
 *    (smoke-packaged.mjs 用它把假库指到 os.tmpdir 临时目录;覆写会让 global
 *    包的 smoke 数据写进真实 CindyGlobal 目录、临时目录清了个空)。
 *  - 只决定**目录名**,拼绝对路径(appData 基址)留给调用方——本模块保持
 *    零 Electron 依赖,可直接单测。
 */

import {
  BRAND_IDENTITY,
  brandUserDataDirName,
  type CindyRegion,
} from '@cindy/maker-shared/brand-identity';

/** argv 里是否显式指定了 Chromium 原生 --user-data-dir(= 与空格两种形态)。 */
function hasExplicitUserDataDir(argv: readonly string[]): boolean {
  return argv.some((a) => a === '--user-data-dir' || a.startsWith('--user-data-dir='));
}

/**
 * 解析本构建是否需要覆写 userData 目录。
 * 返回目录名(调用方拼到 appData 下)或 null(保持 Electron 默认)。
 */
export function resolveRegionUserDataDirName(input: {
  isPackaged: boolean;
  region: CindyRegion;
  argv: readonly string[];
}): string | null {
  if (!input.isPackaged) return null;
  if (hasExplicitUserDataDir(input.argv)) return null;
  const dirName = brandUserDataDirName(input.region);
  // 与 productName 默认派生目录同名(cn)→ 不覆写,走 Electron 原生路径。
  if (dirName === BRAND_IDENTITY.userDataDirName) return null;
  return dirName;
}
