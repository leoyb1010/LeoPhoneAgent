import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * 回归守卫:DropdownMenuSubContent 必须走 Portal 渲染。
 * -------------------------------------------------------------------------
 * 背景(「移动到项目」子菜单点了没反应):CINDY 毛玻璃主题给菜单 surface
 * (MENU_CONTENT_CLASS,含 bg-[var(--cmd-palette-bg)])加了 `backdrop-filter: blur`
 * (globals.css E4D 毛玻璃)。`backdrop-filter` 非 none 会让父 DropdownMenuContent
 * 成为 fixed 定位后代的 containing block,于是原地渲染(非 Portal)的 SubContent
 * 的 Popper wrapper(position:fixed)被父 Content 的 `overflow-hidden` 裁掉,
 * 子菜单整块不可见。把 SubContent Portal 到 body 可根治。删除 Portal 会让子菜单
 * 在毛玻璃主题下重新消失,故用本测试钉死。
 */
describe('DropdownMenuSubContent portal guard', () => {
  const source = readFileSync(resolve(__dirname, '..', 'dropdown-menu.tsx'), 'utf8');

  it('wraps SubContent in a Portal so glass-blur ancestors cannot clip it', () => {
    // 抓取 DropdownMenuSubContent 定义块,断言其内部先出现 Portal 再出现 SubContent。
    const match = source.match(/const DropdownMenuSubContent[\s\S]*?\n\)\);/);
    expect(match, 'DropdownMenuSubContent definition should exist').not.toBeNull();
    const block = match![0];
    expect(block).toContain('<DropdownMenuPrimitive.Portal>');
    expect(block).toContain('<DropdownMenuPrimitive.SubContent');
    // Portal 必须包住 SubContent(Portal 开标签在 SubContent 之前)。
    expect(block.indexOf('<DropdownMenuPrimitive.Portal>')).toBeLessThan(
      block.indexOf('<DropdownMenuPrimitive.SubContent'),
    );
  });
});
