/**
 * highlightSegments — 把 title 按命中字符下标切成高亮 / 非高亮 segments
 * ---------------------------------------------------------------------------
 * 配合 fuzzyMatch 的 indices 输出使用。纯展示函数,无副作用,可单测。
 *
 * 视觉:命中字符加粗 + 字色 #262626 (Light) / #f5f5f5 (Dark)——复用 sidebar
 * 标题色,避免 docs/design-rules/cindy-design-system.md 禁止的色彩 token。非命中字符沿用父级 text-foreground。
 *
 * 健壮性约定:
 *   - indices 必须严格升序、都在 [0, title.length) 内(由 fuzzyMatch 保证);
 *     遇到越界/乱序索引时 silently skip(不抛、不渲染异常字符)
 *   - indices 为空数组 → 直接返回原 title 字符串(零开销)
 *   - title 为空 → 返回空字符串
 *
 * 注:文件后缀 .tsx 因为返回 ReactNode(包含 <mark>);其他 cc-agent/lib/* 文件
 * 全是 .ts。本文件是 lib/ 下唯一的 .tsx,保留是因为 segments 渲染算"对 fuzzy
 * 输出的 React-side 适配",放在 lib/ 一起便于和 fuzzyMatch.ts 共用单测目录。
 */

import type { ReactNode } from 'react';

export interface HighlightSegmentsOptions {
  /**
   * 自定义高亮字符的 className,默认走 sidebar 标题色 + bold:
   * `'bg-transparent font-semibold text-[#262626] dark:text-[#f5f5f5]'`
   */
  highlightClassName?: string;
}

const DEFAULT_HIGHLIGHT_CLASS =
  'bg-transparent font-semibold text-[var(--msg-assistant-text)]';

/**
 * 把 title 切成混合数组,命中字符包在 `<mark>` 中,其它返回纯字符串。
 *
 * @param title    要渲染的源文本
 * @param indices  命中字符在 title 中的下标(严格升序;越界/乱序的会被 skip)
 * @param options  可选样式覆盖
 * @returns        ReactNode(可能是 string 或 (string | ReactElement)[])
 */
export function highlightSegments(
  title: string,
  indices: readonly number[],
  options?: HighlightSegmentsOptions,
): ReactNode {
  if (!title) return '';
  if (indices.length === 0) return title;

  const cls = options?.highlightClassName ?? DEFAULT_HIGHLIGHT_CLASS;
  const out: ReactNode[] = [];
  let cursor = 0;
  for (let k = 0; k < indices.length; k += 1) {
    const i = indices[k];
    // 防御:跳过越界 / 与 cursor 颠倒(乱序)的 index
    if (i < cursor || i >= title.length) continue;
    if (i > cursor) out.push(title.slice(cursor, i));
    out.push(
      <mark key={i} className={cls}>
        {title[i]}
      </mark>,
    );
    cursor = i + 1;
  }
  if (cursor < title.length) out.push(title.slice(cursor));
  return out;
}
