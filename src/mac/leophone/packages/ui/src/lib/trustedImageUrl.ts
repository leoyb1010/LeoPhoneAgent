// [leo] 官方站点 / CDN（z.ai、bigmodel.cn、zhipuai.cn 及其子域）的远程资源一律不加载、不外链；
// 图片由各展示组件已有的本地图标回退兜住。
const OFFICIAL_SERVICE_HOST_PATTERN = /(^|\.)(z\.ai|bigmodel\.cn|zhipuai\.cn)$/i;

export function isOfficialServiceUrl(url: string): boolean {
  try {
    return OFFICIAL_SERVICE_HOST_PATTERN.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** UI 远端图片只允许 HTTPS；失败时由各展示组件回退到本地图标。 */
export function isTrustedImageUrl(url: string | undefined): url is string {
  return typeof url === "string" && url.startsWith("https://") && !isOfficialServiceUrl(url);
}
