import { describe, expect, it } from 'vitest';
import { buildMobileMarkdownTableColumnWidths } from '@/session/messageTableLayout';
import type { MobileMarkdownInline, MobileMarkdownTableRow } from '@/session/messageMarkdown';

describe('messageTableLayout', () => {
  it('builds stable shared column widths for compact assistant tables', () => {
    const header = inlineCells(['项目', '大小', '处理']);
    const rows: MobileMarkdownTableRow[] = [
      row('r1', ['用户临时文件 Temp', '~529MB', '现在直接清']),
      row('r2', ['Windows 更新缓存', '~621MB', '现在直接清']),
      row('r3', ['Downloads\\RJ406835.zip', '8.42GB', '删除前再跟你确认一次']),
    ];

    const widths = buildMobileMarkdownTableColumnWidths({
      header,
      rows,
      minWidth: 96,
    });

    expect(widths).toHaveLength(3);
    expect(widths[0]).toBeGreaterThan(widths[1]);
    expect(widths[2]).toBeGreaterThan(widths[1]);
    expect(widths.every((width) => width >= 96)).toBe(true);
  });

  it('includes missing cells in the shared column count', () => {
    const widths = buildMobileMarkdownTableColumnWidths({
      header: inlineCells(['Name']),
      rows: [
        row('r1', ['Item', 'Status']),
      ],
      minWidth: 96,
    });

    expect(widths).toHaveLength(2);
  });
});

function row(key: string, cells: string[]): MobileMarkdownTableRow {
  return {
    key,
    cells: inlineCells(cells),
  };
}

function inlineCells(cells: string[]): MobileMarkdownInline[][] {
  return cells.map((text) => [{ type: 'text', text }]);
}
