/**
 * parseOmnibox —— Chrome 风格的 URL bar 输入解析(URL or Search)。
 *
 * 用户在浏览器 URL bar 里敲 Enter 时,可能想:
 *   1) 跳到一个完整 URL(带 scheme):`https://github.com`
 *   2) 跳到一个无 scheme 的域名/路径:`github.com` / `localhost:3000` / `1.1.1.1`
 *   3) 搜索:`react hooks tutorial` / `如何写 javascript`
 *
 * 解析规则(对齐 Chrome / Edge / Codex 行为):
 *   A) 显式 scheme (`http://` / `https://` / `about:` / `file:`) → 原文 navigate
 *   B) 否则,看能否当成"主机:端口" 或 "host/path":
 *      - 含 `.` 且无空格,或形如 `localhost:port` / `host:port` 或裸 IP
 *        → 加 `https://` 前缀 navigate
 *   C) 其它(含空格 / 一个无 . 的词 / 中文 query)→ Google 搜索
 *
 * 这套规则故意把"模糊地带"偏向"加 https"(b 分支):用户敲 `github.com` 期望
 * 直接跳,而不是搜索 "github.com"。但 `react hooks` 含空格,落到 c。
 *
 * 项目自加(Codex 浏览器**没做** omnibox 搜索),理由:大多数用户已经习惯 Chrome
 * 这套"输入即搜索"语义,只支持 URL 体感不像浏览器。Codex 自己也提了"URL or search"
 * 但代码里没有实现,我们补上这块体验对标。
 */

/** Google 搜索引擎模板。后续如果做"自定义搜索引擎"先把这个抽出来。 */
const SEARCH_URL_TEMPLATE = 'https://www.google.com/search?q=';

/** 已知 scheme 前缀 —— 命中直接走原文。 */
const KNOWN_SCHEMES = ['http://', 'https://', 'about:', 'file://', 'ftp://', 'data:'];

export interface ParseOmniboxOptions {
  /**
   * Chrome-style Ctrl+Enter completion: `example` -> `https://www.example.com`.
   * Only applies to a single bare label. Existing URLs, dotted domains, paths,
   * ports, and search queries keep the normal Enter behavior.
   */
  ctrlEnter?: boolean;
}

/**
 * 把 URL bar 输入解析成一个最终要 loadURL 的字符串。
 *
 * @returns 永远返回非空 URL —— 空 input 返回 about:blank 兜底,caller 可直接 loadURL。
 */
export function parseOmnibox(input: string, options: ParseOmniboxOptions = {}): string {
  const trimmed = input.trim();
  if (!trimmed) return 'about:blank';

  // A) 显式 scheme
  const lower = trimmed.toLowerCase();
  for (const scheme of KNOWN_SCHEMES) {
    if (lower.startsWith(scheme)) return trimmed;
  }

  if (options.ctrlEnter && looksLikeBareSingleLabel(trimmed)) {
    return `https://www.${trimmed}.com`;
  }

  // C-pre) 含空格 → 一定是搜索(不可能是合法 URL)。提前判,免得后面误判 host。
  if (/\s/.test(trimmed)) {
    return SEARCH_URL_TEMPLATE + encodeURIComponent(trimmed);
  }

  // B) 看像不像主机名:
  //   - 含点(可能是域名或裸 IP):github.com / 1.1.1.1
  //   - 或 host:port 形式(localhost:3000)
  //   命中其一 → 加 https://
  if (looksLikeHost(trimmed)) {
    return 'https://' + trimmed;
  }

  // C) 落到搜索
  return SEARCH_URL_TEMPLATE + encodeURIComponent(trimmed);
}

/**
 * 判定 `s` 是否长得像一个"主机或主机:端口/路径"。
 *
 * 规则:
 *   - 含 `.` —— 大部分情况是域名(github.com)或 IP(1.1.1.1)。即使是 `foo.bar` 这种
 *     没注册的也判为 host,跟 Chrome 行为一致(直接跳,DNS 失败再走 fallback search)。
 *   - 不含 `.` 但有 `:` —— 检查 `:` 后是不是端口号(localhost:3000 / 127.0.0.1:8080)。
 *     `:` 后必须是 1-5 位数字。光看 `:` 还不行(`hello:world` 不是 host)。
 *   - 否则不算 host(一个孤词 `react` / `javascript` 走搜索)。
 *
 * 不做完整 DNS / URL 校验 —— 那是 navigate 后 chromium 自己的事。这里只做模糊
 * 启发式区分"想跳 vs 想搜"。
 */
function looksLikeHost(s: string): boolean {
  // 含 . → host(几乎)
  if (s.includes('.')) {
    // 排除全是 `.` 或 `..` 这种异常,这种走搜索
    if (s.replace(/\./g, '') === '') return false;
    return true;
  }
  // host:port —— `:` 后必须是端口号
  const colonIdx = s.indexOf(':');
  if (colonIdx > 0) {
    const host = s.slice(0, colonIdx);
    const port = s.slice(colonIdx + 1);
    if (host && /^\d{1,5}$/.test(port)) return true;
  }
  return false;
}

function looksLikeBareSingleLabel(s: string): boolean {
  if (/\s/.test(s)) return false;
  if (s.includes('.') || s.includes(':') || s.includes('/')) return false;
  return /^[a-z0-9-]+$/i.test(s);
}
