/**
 * device-link-base.mjs — 冒烟 / mock 脚本共享的 device-link API base 推导
 * (原先 6 个脚本各持一份逐字节相同的副本,2026-07 端点收敛时抽到这里)。
 * 只剩本地 e2e 语义:mock host 3333 → relay 3335 的端口替换。原"生产 API 域名
 * → relay 域名"的 hostname 替换分支已随 apiBaseUrl(老主 server)2026-07-18
 * 退役删除——生产域名不再存在,该分支永远走不到。
 */

/** 从本地 mock API base 推导 device-link relay base:3333 → 3335,其余原样返回。 */
export function deriveDeviceLinkApiBase(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    // Keep the historical single-base behavior for unusual test URLs.
    return baseUrl;
  }
  if (url.port === '3333') {
    url.port = '3335';
    return url.toString();
  }
  return baseUrl;
}
