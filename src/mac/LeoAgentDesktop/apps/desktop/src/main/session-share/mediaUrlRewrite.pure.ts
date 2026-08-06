/**
 * 会话分享的媒体 URL 收集与重写(纯字符串逻辑,零 IO)。
 *
 * 消息 content(JSON 字符串)里可能引用 5 种自定义协议的媒体,分两类语义:
 *
 * 托管缓存类(URL 指向 userData 受管目录,导入端写回对应缓存目录):
 *   xdt-image://{sessionId|reserved-host}/{filename}   — 图片,目录按 sessionId 分,
 *                                                        导入换新 session id 时需重写 host 段
 *   xdt-video://{reserved-host}/{filename}             — 视频,全局文件名,URL 不变
 *   xdt-model://{reserved-host}/{filename}             — 3D 模型,全局文件名,URL 不变
 *
 * 绝对路径引用类(URL 包装本机任意绝对路径,导入端落到新位置后重写 ?path=):
 *   xdt-file://local/?path=<percent-encoded-abs-path>
 *   xdt-audio://local/?path=<percent-encoded-abs-path>
 *
 * 内容寻址类(cindy-media 媒体总仓,docs/dev-rules/media-storage-and-protocols.md):
 *   cindy-media://blobs/{sha256}.{ext}  — 地址=内容指纹,跨机器天然稳定,
 *                                         导入端写回本机字节仓即可,**永不重写**
 *
 * 重写策略:URL 在 content JSON 字符串里以原样子串出现(路径部分已 percent-encode,
 * 不含需要 JSON 转义的字符),因此按"精确旧 URL → 新 URL"整串替换是安全的,
 * 不需要解析再序列化 JSON(那样反而会破坏未知字段的字节稳定性)。
 */

export type MediaScheme =
  | 'xdt-image'
  | 'xdt-video'
  | 'xdt-model'
  | 'xdt-file'
  | 'xdt-audio'
  | 'cindy-media';

export const MEDIA_SCHEMES: readonly MediaScheme[] = [
  'xdt-image',
  'xdt-video',
  'xdt-model',
  'xdt-file',
  'xdt-audio',
  'cindy-media',
];

/** 与 imageCacheStore.collectSessionImageUrls 相同的 URL 边界字符集。 */
const URL_PATTERN = new RegExp(
  `\\b(?:${MEDIA_SCHEMES.join('|')}):\\/\\/[^\\s"'<>()\\[\\]{}]+`,
  'g',
);

export interface CollectedMediaUrl {
  scheme: MediaScheme;
  url: string;
}

/** 从消息 content(原始 JSON 字符串或任意文本)收集全部媒体 URL,去重保序。 */
export function collectMediaUrls(content: string): CollectedMediaUrl[] {
  const seen = new Set<string>();
  const out: CollectedMediaUrl[] = [];
  for (const match of content.match(URL_PATTERN) ?? []) {
    if (seen.has(match)) continue;
    seen.add(match);
    const scheme = match.slice(0, match.indexOf(':')) as MediaScheme;
    out.push({ scheme, url: match });
  }
  return out;
}

/** 解析 xdt-image URL 的 host 段(sessionId 或 reserved host)与文件名。 */
export function parseImageUrl(url: string): { host: string; filename: string } | null {
  const parsed = tryParseUrl(url);
  if (!parsed || parsed.protocol !== 'xdt-image:') return null;
  // decodeURIComponent 必须兜 try:WHATWG URL 对非特殊 scheme 的 opaque host
  // 容忍非法百分号序列(如 `xdt-image://a%2/f`),decode 会抛裸 URIError,
  // 而本函数契约是"解析不出返回 null"(消费方是导入端,输入不可信)。
  try {
    const host = decodeURIComponent(parsed.hostname);
    const filename = decodeURIComponent(
      parsed.pathname.startsWith('/') ? parsed.pathname.slice(1) : parsed.pathname,
    );
    if (!host || !filename) return null;
    return { host, filename };
  } catch {
    return null;
  }
}

/** 解析 xdt-file / xdt-audio URL 里 ?path= 的绝对路径(未解析出来返回 null)。 */
export function extractLoosePath(url: string): string | null {
  const parsed = tryParseUrl(url);
  if (!parsed) return null;
  if (parsed.protocol !== 'xdt-file:' && parsed.protocol !== 'xdt-audio:') return null;
  const raw = parsed.searchParams.get('path');
  return raw ? raw : null;
}

/**
 * 用新绝对路径重建 loose URL(scheme 与原 URL 保持一致)。
 * encodeURIComponent 不转义 ()!'*,而收集端 URL_PATTERN 以括号/引号为边界——
 * 文件名含 `report (final).pdf` 这类字符时,重建的 URL 会在下一次收集被截断
 * (review bot 指出)。这里把这几个字符补齐为百分号转义,保证重建产物永远
 * 落在 URL_PATTERN 的安全字符集内;extractLoosePath 走 URLSearchParams 解码,
 * 额外转义不影响还原。
 */
export function buildLooseUrl(scheme: 'xdt-file' | 'xdt-audio', absPath: string): string {
  const encoded = encodeURIComponent(absPath).replace(
    /[()!'*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${scheme}://local/?path=${encoded}`;
}

export interface MediaRewriteRules {
  /** xdt-image 的 per-session host 段替换(reserved host 不动)。 */
  imageSessionId?: { from: string; to: string };
  /** 精确 URL → 新 URL 的整串替换(loose 类落位后的 ?path= 重写)。 */
  urlMap?: ReadonlyMap<string, string>;
}

/** 按规则重写 content 里的媒体 URL,返回新字符串(无命中时原样返回)。 */
export function rewriteMediaUrls(content: string, rules: MediaRewriteRules): string {
  let result = content;
  if (rules.urlMap && rules.urlMap.size > 0) {
    // 单趟整 token 替换:用与收集端相同的 URL 边界正则扫出完整 URL,整体查表。
    // 逐条 split/join 有两类边缘坑(review bot 两轮指出):短 URL 是长 URL 前缀时
    // 截断后者;某条的替换输出可能被后续条目二次改写。整 token 单趟天然免疫,
    // from===to 的恒等映射也自然 no-op。
    const map = rules.urlMap;
    result = result.replace(URL_PATTERN, (match) => map.get(match) ?? match);
  }
  if (rules.imageSessionId && rules.imageSessionId.from !== rules.imageSessionId.to) {
    result = result
      .split(`xdt-image://${rules.imageSessionId.from}/`)
      .join(`xdt-image://${rules.imageSessionId.to}/`);
  }
  return result;
}

function tryParseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}
