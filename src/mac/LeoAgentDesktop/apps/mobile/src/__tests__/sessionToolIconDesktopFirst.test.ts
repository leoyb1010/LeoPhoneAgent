import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('desktop-first mobile tool icons', () => {
  it('keeps search navigation as compact icon controls and sheets without root close buttons', () => {
    const source = readFileSync(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');

    expect(source).toContain('ChevronDown');
    expect(source).toContain('ChevronUp');
    expect(source).toContain('<ChevronUp color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />');
    expect(source).toContain('<ChevronDown color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />');
    expect(source).toContain('testID="session.searchPreviousButton"');
    expect(source).toContain('testID="session.searchNextButton"');
    // 底部 sheet 统一 SheetModal 外壳(背板淡入 + 面板滑入),根级关闭 X 移除:
    // 把手下拉 / 点背板关闭已足够,队列 / 搜索 sheet 只保留视觉把手
    // (把手收敛为 SheetSurface 导出的共享 SheetGrabber 组件)。
    expect(source).toContain('<SheetModal');
    expect(source).toContain('<SheetGrabber');
    expect(source).not.toContain('sheetCloseButton');
    expect(source).not.toContain('testID="queue.closeButton"');
    expect(source).not.toContain('testID="session.searchCloseButton"');
    expect(source).not.toContain('searchNavText');
    expect(source).not.toContain('>关闭</Text>');
    expect(source).not.toContain('>上一条</Text>');
    expect(source).not.toContain('>下一条</Text>');
  });
});
