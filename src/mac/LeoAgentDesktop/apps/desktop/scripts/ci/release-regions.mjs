// =============================================================================
// release-regions.mjs —— desktop 发布「地区渠道」配置的唯一加载入口(cn / global)
//
// 对齐 mobile 自建线的 self-host-regions 模式(apps/mobile/scripts/lib/self-host-region.mjs):
// 随地区变化的**非机密**发布参数集中在发版机本地的 scripts/release-regions.json 里
// (纯值,不入仓;只提交 .json.example):
//   - oss:发布目标(CDN 基址 / OSS bucket / prefix / ossRegion);
//   - macSigning(可选):mac 签名/公证身份(appleId / teamId / signIdentity,
//     以及可选 appPasswordEnv——公证密码改从哪个 env 变量读,供两区域使用不同
//     公证账号/密码时按区域指路;密码值本身永远只在 env,不进 JSON。
//     证书私钥本体在 macOS 钥匙串,按 signIdentity 名字取)——国内/海外用不同
//     Developer ID 证书(X.D. Network / XD Entertainment)时在此按区域声明;
//     resolveAppleIdentity 无代码默认值,JSON 与 env 都缺时在签名前 fail closed。
// 真机密(OSS AK/SK、APPLE_APP_PASSWORD、签名命令等)仍走 env / .env,凭证不入仓。
//
// 与既有 env 驱动(XDT_* / XDT_GLOBAL_*,CI secret 场景)的关系:
//   - env 已显式设置的键永远优先,JSON 只补 env 里缺失的键(与 .env 加载语义一致);
//   - env 四件套齐全时允许没有 JSON 文件(CI 不需要发版机文件);
//   - 两边合并后仍缺键 → 立即抛错并同时指出 JSON 字段与 env 变量名,禁止回落默认值。
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveReleaseRegion } from '../../../../scripts/shared/oss.mjs';

const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RELEASE_REGIONS_PATH = path.join(SCRIPTS_DIR, 'release-regions.json');
export const RELEASE_REGIONS_EXAMPLE_PATH = path.join(SCRIPTS_DIR, 'release-regions.json.example');

/** 每个 region 的 oss 配置块字段 → 对应的既有 env 变量名(refreshOssConfig 的最终读取面)。 */
export const RELEASE_REGION_ENV_NAMES = Object.freeze({
  cn: Object.freeze({
    cdnBaseUrl: 'XDT_CDN_BASE_URL',
    bucket: 'XDT_OSS_BUCKET',
    prefix: 'XDT_OSS_PREFIX',
    ossRegion: 'XDT_OSS_REGION',
  }),
  global: Object.freeze({
    cdnBaseUrl: 'XDT_GLOBAL_CDN_BASE_URL',
    bucket: 'XDT_GLOBAL_OSS_BUCKET',
    prefix: 'XDT_GLOBAL_OSS_PREFIX',
    ossRegion: 'XDT_GLOBAL_OSS_REGION',
  }),
  // dev 第三渠道:XDT_DEVCH_* 前缀(dev channel,避免与 FP_DEV_* 凭证名混淆)。
  dev: Object.freeze({
    cdnBaseUrl: 'XDT_DEVCH_CDN_BASE_URL',
    bucket: 'XDT_DEVCH_OSS_BUCKET',
    prefix: 'XDT_DEVCH_OSS_PREFIX',
    ossRegion: 'XDT_DEVCH_OSS_REGION',
  }),
});

const OSS_KEYS = Object.freeze(['cdnBaseUrl', 'bucket', 'prefix', 'ossRegion']);

/** macSigning 字段 → resolveAppleIdentity 读取的 env 名(两区域同名:一次发布只有一个 region)。 */
export const MAC_SIGNING_ENV_NAMES = Object.freeze({
  appleId: 'APPLE_ID',
  teamId: 'APPLE_TEAM_ID',
  signIdentity: 'APPLE_SIGN_IDENTITY',
});
const MAC_SIGNING_KEYS = Object.freeze(Object.keys(MAC_SIGNING_ENV_NAMES));

/** 解析真文件路径;显式 env 覆盖仅供测试 / 特殊发版机。 */
export function resolveReleaseRegionsPath(filePath = process.env.CINDY_RELEASE_REGIONS_FILE) {
  if (!filePath?.trim()) return RELEASE_REGIONS_PATH;
  return path.resolve(SCRIPTS_DIR, filePath.trim());
}

/**
 * 读取并校验发版机本地的 release-regions.json。返回冻结的 { cn, global }。
 * 叶子值允许为空字符串(只发单渠道的机器不必填另一渠道),用到时由
 * applyReleaseRegionConfigToEnv 按本次 --region 强校验。
 * @param {{ filePath?: string }} [options]
 */
export function loadReleaseRegions(options = {}) {
  const configPath = resolveReleaseRegionsPath(options.filePath);
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error(
        `缺少 desktop 发布地区配置: ${configPath}。请复制 ${RELEASE_REGIONS_EXAMPLE_PATH} 为 release-regions.json 并在发版机上填值(该文件已 gitignore)。`,
      );
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`desktop 发布地区配置不是合法 JSON: ${configPath}`);
  }
  return validateReleaseRegions(parsed, { source: configPath });
}

/**
 * 校验 { cn: { oss }, global: { oss } } 结构;叶子必须是字符串,允许为空。
 * @param {unknown} value
 * @param {{ source?: string }} [options]
 */
export function validateReleaseRegions(value, options = {}) {
  const source = options.source ?? 'release regions';
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${source} 必须是 JSON object`);
  }
  const result = {};
  for (const region of Object.keys(RELEASE_REGION_ENV_NAMES)) {
    const block = value[region];
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      throw new Error(`${source} 缺少 region 配置块: ${region}`);
    }
    const oss = block.oss;
    if (!oss || typeof oss !== 'object' || Array.isArray(oss)) {
      throw new Error(`${source} 的 ${region}.oss 必须是 object`);
    }
    const normalizedOss = {};
    for (const key of OSS_KEYS) {
      if (typeof oss[key] !== 'string') {
        throw new Error(`${source} 的 ${region}.oss.${key} 必须是字符串(可留空,发该渠道时才要求非空)`);
      }
      normalizedOss[key] = oss[key].trim();
    }
    const normalized = { oss: Object.freeze(normalizedOss) };
    if (block.macSigning !== undefined) {
      const mac = block.macSigning;
      if (!mac || typeof mac !== 'object' || Array.isArray(mac)) {
        throw new Error(`${source} 的 ${region}.macSigning 必须是 object(可整体省略)`);
      }
      const normalizedMac = {};
      for (const key of MAC_SIGNING_KEYS) {
        const value = mac[key] ?? '';
        if (typeof value !== 'string') {
          throw new Error(`${source} 的 ${region}.macSigning.${key} 必须是字符串(可留空,回落代码默认身份)`);
        }
        normalizedMac[key] = value.trim();
      }
      const passwordEnv = mac.appPasswordEnv ?? '';
      if (typeof passwordEnv !== 'string' || (passwordEnv.trim() && !/^[A-Z][A-Z0-9_]*$/.test(passwordEnv.trim()))) {
        throw new Error(`${source} 的 ${region}.macSigning.appPasswordEnv 必须是合法 env 变量名(全大写,可留空 = 读 APPLE_APP_PASSWORD)`);
      }
      normalizedMac.appPasswordEnv = passwordEnv.trim();
      normalized.macSigning = Object.freeze(normalizedMac);
    }
    result[region] = Object.freeze(normalized);
  }
  return Object.freeze(result);
}

/**
 * 把本次发布 region 的 JSON 配置合并进 env(只补 env 缺失的键,env 显式值优先),
 * 供随后的 refreshOssConfig(region) / resolveReleaseCdnBaseUrl(region) 读取。
 *
 * 行为:
 *   - env 四件套齐全 → 不要求 JSON 文件存在(CI secret 场景),返回 { source: 'env' };
 *   - 否则必须能读到 JSON 且补齐缺口,返回 { source: 'file' };
 *   - 合并后仍缺 → 抛错,同时指出 JSON 字段与 env 变量名。
 * @param {string} region cn | global
 * @param {{ filePath?: string }} [options]
 */
/**
 * 只把本次 region 的 cdnBaseUrl 合并进 env(env 显式值优先),供只读的 CDN
 * manifest 拉取(如打包阶段的版本 bump 基线)使用——不要求 bucket/AK 等发布
 * 四件套,打包机不必具备发布配置的其余部分。
 * @param {string} region cn | global | dev
 * @param {{ filePath?: string }} [options]
 */
export function applyReleaseCdnBaseUrlToEnv(region, options = {}) {
  const normalized = resolveReleaseRegion(region);
  const envName = RELEASE_REGION_ENV_NAMES[normalized].cdnBaseUrl;
  if (process.env[envName]?.trim()) return { source: 'env' };
  const configPath = resolveReleaseRegionsPath(options.filePath);
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `缺少 ${normalized} 渠道 CDN 基址(版本 bump 需要拉线上 manifest 算基线)。二选一:\n` +
        `  1) 复制 ${RELEASE_REGIONS_EXAMPLE_PATH} 为 release-regions.json 并填入 ${normalized}.oss.cdnBaseUrl;\n` +
        `  2) 设置环境变量 ${envName};\n` +
        `  或显式传 --version x.y.z 完全离线打包。`,
    );
  }
  const block = loadReleaseRegions({ filePath: options.filePath })[normalized].oss;
  if (!block.cdnBaseUrl) {
    throw new Error(`${configPath} 的 ${normalized}.oss.cdnBaseUrl 为空(或改设 env ${envName},或显式传 --version x.y.z)`);
  }
  process.env[envName] = block.cdnBaseUrl;
  return { source: 'file' };
}

export function applyReleaseRegionConfigToEnv(region, options = {}) {
  const normalized = resolveReleaseRegion(region);
  const envNames = RELEASE_REGION_ENV_NAMES[normalized];
  const missingFromEnv = OSS_KEYS.filter((key) => !process.env[envNames[key]]?.trim());
  const configPath = resolveReleaseRegionsPath(options.filePath);
  if (missingFromEnv.length === 0) {
    // OSS 面由 env 提供(CI secret 场景);JSON 存在时仍应用其 macSigning 身份。
    if (fs.existsSync(configPath)) {
      applyMacSigningEnv(loadReleaseRegions({ filePath: options.filePath })[normalized].macSigning);
    }
    return { source: 'env' };
  }

  if (!fs.existsSync(configPath)) {
    throw new Error(
      `缺少 ${normalized} 渠道发布配置。二选一:\n` +
        `  1) 复制 ${RELEASE_REGIONS_EXAMPLE_PATH} 为 release-regions.json 并填入 ${normalized}.oss.*(推荐,已 gitignore);\n` +
        `  2) 设置环境变量 ${missingFromEnv.map((key) => envNames[key]).join(' / ')}(CI secret 场景)。`,
    );
  }

  const regions = loadReleaseRegions({ filePath: options.filePath });
  const block = regions[normalized].oss;
  const stillMissing = [];
  for (const key of OSS_KEYS) {
    const envName = envNames[key];
    if (process.env[envName]?.trim()) continue;
    if (block[key]) {
      process.env[envName] = block[key];
    } else {
      stillMissing.push(`${normalized}.oss.${key}(或 env ${envName})`);
    }
  }
  if (stillMissing.length > 0) {
    throw new Error(`${configPath} 的 ${normalized} 渠道配置不完整,缺: ${stillMissing.join(', ')}`);
  }
  applyMacSigningEnv(regions[normalized].macSigning);
  return { source: 'file' };
}

/**
 * 只应用 macSigning 身份、不要求 oss 配置——供「只打包不发布」的入口
 * (package-desktop.mjs)使用:签名需要身份,但本地打包不需要发布目标。
 * 文件不存在时静默跳过(身份可由 env 提供;都没有则 resolveAppleIdentity 抛错)。
 * @param {string} region cn | global
 * @param {{ filePath?: string }} [options]
 * @returns {boolean} 是否读到了配置文件
 */
export function applyMacSigningConfigToEnv(region, options = {}) {
  const normalized = resolveReleaseRegion(region);
  const configPath = resolveReleaseRegionsPath(options.filePath);
  if (!fs.existsSync(configPath)) return false;
  applyMacSigningEnv(loadReleaseRegions({ filePath: options.filePath })[normalized].macSigning);
  return true;
}

/**
 * 把 region 的 macSigning 身份注入 APPLE_* env(仅补 env 缺失的键;留空的字段
 * 跳过——resolveAppleIdentity 无默认值,最终仍缺会在签名前抛错)。
 * @param {{ appleId?: string, teamId?: string, signIdentity?: string } | undefined} macSigning
 */
function applyMacSigningEnv(macSigning) {
  if (!macSigning) return;
  for (const key of MAC_SIGNING_KEYS) {
    const envName = MAC_SIGNING_ENV_NAMES[key];
    if (process.env[envName]?.trim()) continue;
    if (macSigning[key]) process.env[envName] = macSigning[key];
  }
  // appPasswordEnv:公证密码指针。显式 APPLE_APP_PASSWORD 仍优先(与全局 env-first
  // 一致)。指针指向的 env 为空时只警告、不在加载期抛错:加载点在「是否真签名」
  // 决策之前,ad-hoc / versionless / --allow-unsigned 流程根本用不到密码,提前抛
  // 会拦住合法的无签名打包。fail closed 语义在真签名消费点兜底——有版本打包缺
  // APPLE_APP_PASSWORD 时由 finish/publish 侧闸门报错(声明即承诺,只是延后到用时)。
  if (macSigning.appPasswordEnv && !process.env.APPLE_APP_PASSWORD?.trim()) {
    const value = process.env[macSigning.appPasswordEnv]?.trim();
    if (!value) {
      // 不把指针值写进日志(CodeQL 将 *PasswordEnv 相关取值视作敏感数据流);
      // 指针名去 release-regions.json 的 macSigning.appPasswordEnv 字段查即可。
      console.warn(
        'WARN: macSigning.appPasswordEnv 指向的环境变量未设置或为空(指针名见 release-regions.json);' +
          '真签名(Developer ID + 公证)将在需要密码时报错,ad-hoc 打包不受影响。',
      );
    } else {
      process.env.APPLE_APP_PASSWORD = value;
    }
  }
}
