/**
 * 发布/下载工具的显式环境变量入口；不再回退到仓内私有 JSON。
 * 区域化(国内 cn / 海外 global):cn 读 XDT_CDN_BASE_URL,global 读
 * XDT_GLOBAL_CDN_BASE_URL,与 scripts/shared/oss.mjs 的发布目标同一套命名。
 */
export function resolveReleaseCdnBaseUrl(releaseRegion = 'cn') {
  const envName =
    { global: 'XDT_GLOBAL_CDN_BASE_URL', dev: 'XDT_DEVCH_CDN_BASE_URL' }[releaseRegion] ??
    'XDT_CDN_BASE_URL';
  const raw = process.env[envName]?.trim();
  if (!raw) {
    throw new Error(`缺少发布 CDN 配置: 请设置 ${envName}`);
  }
  return raw.replace(/\/+$/, '');
}
