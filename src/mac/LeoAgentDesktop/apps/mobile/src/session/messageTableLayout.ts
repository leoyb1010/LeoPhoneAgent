import type { MobileMarkdownInline, MobileMarkdownTableRow } from '@/session/messageMarkdown';

export interface MobileMarkdownTableColumnWidthInput {
  header: readonly MobileMarkdownInline[][];
  rows: readonly MobileMarkdownTableRow[];
  minWidth: number;
  maxWidth?: number;
}

const DEFAULT_MAX_COLUMN_WIDTH = 220;
const CELL_HORIZONTAL_PADDING = 20;
const TEXT_UNIT_WIDTH = 7.4;
// 图片 inline 没有声明 width 时按缩略图常见宽度估列宽(最终仍被 maxWidth clamp)。
const DEFAULT_IMAGE_INLINE_WIDTH = 150;

export function buildMobileMarkdownTableColumnWidths({
  header,
  rows,
  minWidth,
  maxWidth = DEFAULT_MAX_COLUMN_WIDTH,
}: MobileMarkdownTableColumnWidthInput): number[] {
  const columnCount = Math.max(
    header.length,
    ...rows.map((row) => row.cells.length),
  );
  if (columnCount <= 0) return [];
  return Array.from({ length: columnCount }, (_, columnIndex) => {
    const contentWidth = Math.max(
      estimateInlineWidth(header[columnIndex] ?? []),
      ...rows.map((row) => estimateInlineWidth(row.cells[columnIndex] ?? [])),
    );
    return clampWidth(
      Math.ceil(contentWidth + CELL_HORIZONTAL_PADDING),
      minWidth,
      Math.max(minWidth, maxWidth),
    );
  });
}

function estimateInlineWidth(inlines: readonly MobileMarkdownInline[]): number {
  return inlines.reduce((total, inline) => (
    inline.type === 'image'
      ? total + (inline.width ?? DEFAULT_IMAGE_INLINE_WIDTH)
      : total + estimateTextWidth(inline.text)
  ), 0);
}

function estimateTextWidth(text: string): number {
  let units = 0;
  for (const char of Array.from(text)) {
    if (/\s/.test(char)) {
      units += 0.5;
    } else if (isWideGlyph(char)) {
      units += 1.9;
    } else {
      units += 1;
    }
  }
  return units * TEXT_UNIT_WIDTH;
}

function isWideGlyph(char: string): boolean {
  return /[\u1100-\u11ff\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/u.test(char);
}

function clampWidth(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
