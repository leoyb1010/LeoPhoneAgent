// 尾部 ASCII 标点集合：GFM spec 会剥掉 ? ! . , : * _ ~，此处额外加了 ;
// 以便把 `https://x.com/foo; 然后` 这类散文分号也视为 URL 边界。
// 用在我们自己的 plain-text linkifier 和 remark 后处理里，避免两条渲染链路
// 对 `https://x.com/foo.` / `https://x.com/foo(base` 这类边界给出不同结果。

const PROSE_TRAILING_PUNCT = new Set(['?', '!', '.', ',', ':', ';']);
const MARKDOWN_FORMATTING_TRAILING_PUNCT = new Set(['*', '_', '~']);
export const MARKDOWN_WRAP_MARKERS = ['**', '__', '~~', '*', '_', '~'] as const;

/**
 * 找出裸 URL 中第一个应回退给 prose 的未配对括号位置。
 *
 * GFM autolink 会把 `https://x.com/1(base main)` 的 `base` 当成 URL path
 * 吃掉，因为空格才结束匹配；在聊天文本里 path 末尾这类未配对 `(` 基本
 * 都是 URL 后的说明。配对括号默认保留，兼容 Wikipedia 类 `/Foo_(bar)`；
 * 只有 code-host 数字资源路径（如 `/pull/283`）后的配对括号才按说明切掉。
 * Query / fragment 里的未配对括号默认不动，避免误伤 `?q=(foo` /
 * `?q=a)b` 这类真实 URL；只有 code-host 资源 URL 后明显是状态说明
 * 开头的截断前缀（如 `#discussion_r1(base`）才切回 prose。
 */
export function cutBeforeUnbalancedParenProse(
  raw: string,
  cut: number = raw.length,
  options: { wrappingParenCount?: number } = {},
): number {
  const scanCut = Math.min(Math.max(cut, 0), raw.length);
  const effectiveEnd = trimProseTrailingPunct(raw, scanCut);
  const queryOrHashIndex = raw.search(/[?#]/);
  const wrappingParenCount = options.wrappingParenCount ?? 0;
  const noteEnd = trimUnmatchedTrailingClosers(
    raw,
    trimMarkdownFormattingTrailingPunct(raw, effectiveEnd),
  );
  const openParenIndexes: number[] = [];
  const parenPairs: Array<{ open: number; close: number }> = [];
  for (let i = 0; i < effectiveEnd; i++) {
    const ch = raw[i];
    if (ch === '(') {
      openParenIndexes.push(i);
      continue;
    }
    if (ch !== ')') continue;
    const openIndex = openParenIndexes.pop();
    if (openIndex != null) {
      parenPairs.push({ open: openIndex, close: i });
      continue;
    }
    if (i >= noteEnd) {
      continue;
    }
    if (queryOrHashIndex >= 0 && i >= queryOrHashIndex) {
      if (
        wrappingParenCount > 0 &&
        countUnmatchedClosingParens(raw.slice(i + 1, effectiveEnd)) < wrappingParenCount
      ) {
        return i;
      }
      continue;
    }
    if (raw[i + 1] != null && !/\s/.test(raw[i + 1])) {
      return i;
    }
  }
  return (
    openParenIndexes.find((openIndex) => queryOrHashIndex < 0 || openIndex < queryOrHashIndex) ??
    openParenIndexes.find((openIndex) =>
      isCodeHostTruncatedStatusNote(raw, openIndex, noteEnd, queryOrHashIndex),
    ) ??
    parenPairs.find(
      ({ open, close }) =>
        isCodeHostParentheticalNote(raw, open, close, queryOrHashIndex) &&
        close === noteEnd - 1,
    )?.open ??
    raw.length
  );
}

function isCodeHostTruncatedStatusNote(
  raw: string,
  open: number,
  noteEnd: number,
  queryOrHashIndex: number,
): boolean {
  if (queryOrHashIndex < 0 || open < queryOrHashIndex) return false;
  if (!canTreatQueryOrHashParenAsStatusNote(raw, open, queryOrHashIndex)) return false;
  const notePrefix = raw.slice(open + 1, noteEnd);
  return (
    /^base(?: [A-Za-z0-9._/-]*)?$/i.test(notePrefix) &&
    isCodeHostNumericResourcePath(raw.slice(0, queryOrHashIndex))
  );
}

function isCodeHostParentheticalNote(
  raw: string,
  open: number,
  close: number,
  queryOrHashIndex: number,
): boolean {
  if (queryOrHashIndex < 0 || open < queryOrHashIndex) {
    return isCodeHostNumericResourcePath(raw.slice(0, open));
  }
  if (!canTreatQueryOrHashParenAsStatusNote(raw, open, queryOrHashIndex)) return false;
  const note = raw.slice(open + 1, close);
  return (
    isLikelyCodeHostStatusNote(note) &&
    isCodeHostNumericResourcePath(raw.slice(0, queryOrHashIndex))
  );
}

function canTreatQueryOrHashParenAsStatusNote(
  raw: string,
  open: number,
  queryOrHashIndex: number,
): boolean {
  const lastAmpersand = raw.lastIndexOf('&', open - 1);
  const segmentStart = Math.max(queryOrHashIndex + 1, lastAmpersand + 1);
  const currentSegment = raw.slice(segmentStart, open);
  if (!currentSegment.includes('=')) return true;
  return /^diff=split$/i.test(currentSegment);
}

function isLikelyCodeHostStatusNote(note: string): boolean {
  return /^base(?: [A-Za-z0-9._/-]+)*,[A-Z][A-Z0-9_-]*$/i.test(note);
}

export function isCodeHostNumericResourcePath(prefix: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(prefix);
  } catch {
    return false;
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const pathname = parsed.pathname;
  if (host === 'github.com') {
    return /^\/[^/]+\/[^/]+\/(?:pulls?|issues?)\/\d+\/?$/i.test(pathname);
  }
  if (host === 'gitlab.com') {
    return /^\/.+\/(?:-\/)?(?:issues?|merge_requests?)\/\d+\/?$/i.test(pathname);
  }
  return false;
}

function trimProseTrailingPunct(raw: string, cut: number): number {
  let end = cut;
  while (end > 0 && PROSE_TRAILING_PUNCT.has(raw[end - 1])) {
    end--;
  }
  return end;
}

function trimMarkdownFormattingTrailingPunct(raw: string, cut: number): number {
  let end = cut;
  while (end > 0 && MARKDOWN_FORMATTING_TRAILING_PUNCT.has(raw[end - 1])) {
    end--;
  }
  return end;
}

function trimUnmatchedTrailingClosers(raw: string, cut: number): number {
  let end = cut;
  while (end > 0 && raw[end - 1] === ')') {
    const seg = raw.slice(0, end);
    const opens = (seg.match(/\(/g) ?? []).length;
    const closes = (seg.match(/\)/g) ?? []).length;
    if (closes <= opens) break;
    end--;
  }
  return end;
}

/**
 * Cut authority/path-level square/brace brackets that GFM autolink may treat
 * as URL text. Query and fragment are left alone because brackets are common
 * there after copy/paste from search URLs or app-specific links.
 */
export function cutBeforePathBracketProse(raw: string): number {
  const schemeIndex = raw.indexOf('://');
  const authorityStart = schemeIndex >= 0 ? schemeIndex + 3 : 0;
  const pathStart = raw.indexOf('/', authorityStart);
  const queryOrHashIndex = raw.search(/[?#]/);
  const pathScanEnd = queryOrHashIndex < 0 ? raw.length : queryOrHashIndex;
  for (let i = authorityStart; i < pathScanEnd; i++) {
    if (!'[]{}'.includes(raw[i])) continue;
    if (pathStart >= 0 && i >= pathStart) return i;
    if (canParseUrlPrefix(raw.slice(0, i))) return i;
  }
  const queryBracketCut = cutBeforeUnmatchedQueryBracket(raw, queryOrHashIndex, raw.length);
  if (queryBracketCut < raw.length) return queryBracketCut;
  return raw.length;
}

function canParseUrlPrefix(prefix: string): boolean {
  try {
    const parsed = new URL(prefix);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname !== '';
  } catch {
    return false;
  }
}

function cutBeforeUnmatchedQueryBracket(
  raw: string,
  queryOrHashIndex: number,
  scanEnd: number,
): number {
  if (queryOrHashIndex < 0) return raw.length;
  const counts: Record<string, number> = { ']': 0, '}': 0 };
  const matchingClose: Record<string, ']' | '}'> = { '[': ']', '{': '}' };
  for (let i = queryOrHashIndex; i < scanEnd; i++) {
    const ch = raw[i];
    if (ch === '[' || ch === '{') {
      counts[matchingClose[ch]]++;
      continue;
    }
    if (ch !== ']' && ch !== '}') continue;
    if (counts[ch] <= 0) return i;
    counts[ch]--;
  }
  return raw.length;
}

export function cutBeforeClosingMarkdownWrap(raw: string, marker: string | null): number {
  if (!marker) return raw.length;
  let markerIndex = raw.indexOf(marker);
  while (markerIndex >= 0) {
    if (isMarkdownWrapCloseCandidate(raw, marker, markerIndex)) {
      return markerIndex;
    }
    markerIndex = raw.indexOf(marker, markerIndex + marker.length);
  }
  return raw.length;
}

export function isMarkdownWrapOpenBoundary(ch: string | undefined): boolean {
  return ch == null || !isAsciiAlnum(ch);
}

function isMarkdownWrapCloseCandidate(raw: string, marker: string, markerIndex: number): boolean {
  if (marker !== '_' && marker !== '__') return true;
  const before = raw[markerIndex - 1];
  const after = raw[markerIndex + marker.length];
  return !(isAsciiAlnum(before) && isAsciiAlnum(after));
}

function isAsciiAlnum(ch: string | undefined): boolean {
  return ch != null && /[A-Za-z0-9]/.test(ch);
}

export function countUnmatchedOpeningParens(text: string | null): number {
  if (!text) return 0;
  let count = 0;
  for (const ch of text) {
    if (ch === '(') {
      count++;
      continue;
    }
    if (ch === ')' && count > 0) {
      count--;
    }
  }
  return count;
}

function countUnmatchedClosingParens(text: string): number {
  let openCount = 0;
  let closeCount = 0;
  for (const ch of text) {
    if (ch === '(') {
      openCount++;
      continue;
    }
    if (ch === ')') {
      if (openCount > 0) {
        openCount--;
      } else {
        closeCount++;
      }
    }
  }
  return closeCount;
}

/**
 * 从给定切点继续向左收缩，剥掉 autolink 末尾不该属于 URL 的字符。
 *
 * 保留配对括号，兼容 Wikipedia 类 URL `/Foo_(bar)`；剥掉悬空的 `(` 和
 * 未配对的 `)`，匹配 GFM 对裸 URL 边界的处理习惯。
 */
export function shrinkAutolinkTrailingJunk(
  url: string,
  cut: number = url.length,
  options: {
    stripMarkdownFormattingPunct?: boolean;
    stripWrappingApostrophe?: boolean;
    stripWrappingParenCount?: number;
  } = {},
): number {
  let end = Math.min(Math.max(cut, 0), url.length);
  const queryOrHashIndex = url.search(/[?#]/);
  let stripWrappingParenCount = Math.max(
    0,
    (options.stripWrappingParenCount ?? 0) - countUnmatchedClosingParens(url.slice(end)),
  );
  while (end > 0) {
    const ch = url[end - 1];
    const isInQueryOrFragment = queryOrHashIndex >= 0 && end - 1 >= queryOrHashIndex;
    if (
      PROSE_TRAILING_PUNCT.has(ch) ||
      (options.stripMarkdownFormattingPunct &&
        MARKDOWN_FORMATTING_TRAILING_PUNCT.has(ch)) ||
      (ch === '(' && !isInQueryOrFragment) ||
      (ch === "'" && options.stripWrappingApostrophe)
    ) {
      end--;
      continue;
    }
    if (ch === ')') {
      const seg = url.slice(0, end);
      const opens = (seg.match(/\(/g) ?? []).length;
      const closes = (seg.match(/\)/g) ?? []).length;
      if (closes > opens) {
        if (isInQueryOrFragment) {
          if (stripWrappingParenCount <= 0) break;
          stripWrappingParenCount--;
        }
        end--;
        continue;
      }
    }
    break;
  }
  return end;
}
