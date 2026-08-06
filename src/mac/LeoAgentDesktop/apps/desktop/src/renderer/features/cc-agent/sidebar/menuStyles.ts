/**
 * menuStyles —— sidebar 点击弹出框(DropdownMenu / 右键菜单)的统一视觉常量。
 * ---------------------------------------------------------------------------
 * 背景:侧栏里多处菜单各写各的 surface/item className,token 不一(有的用
 * `bg-popover`/`border-sidebar-border`、有的用 `--cmd-palette-*`,item 高度
 * `h-7`/`h-8` 与 `px-2`/`px-3`、`rounded-md`/`rounded-lg` 混用,个别还用 `hover:`
 * 导致键盘方向键不高亮)。这里把 ConversationSearchBox 里已校准的那套 cmd-palette
 * 规范抽成共享常量,所有 sidebar 菜单统一引用。
 *
 * 约定:常量**不带宽度**,调用方用 `cn(MENU_CONTENT_CLASS, 'w-[248px]')` /
 * `'min-w-[160px]'` 自行组合,保持宽度无关、可复用。
 *
 * 不覆盖:
 *   - 对话搜索那张 640px 命令面板(ConversationSearchBox 的 PopoverContent)——
 *     属"大面板"另一类语言,刻意保留较软的 `--cmd-palette-shadow`,只在其内部
 *     的子菜单/筛选项复用本文件常量。
 *   - ConfirmDialog 等模态(居中弹窗)——非菜单 surface,不在统一范围内。
 */

/** 菜单 surface:圆角 + cmd-palette 底/边 + 标准 menu 阴影 + p-1 内边距。不含宽度。 */
export const MENU_CONTENT_CLASS =
  'rounded-xl border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)] p-1 text-[var(--cmd-palette-item-text)] shadow-[var(--shadow-menu)]';

/** 子菜单 surface —— 与主菜单同款(分开命名只为语义清晰,便于将来差异化)。 */
export const MENU_SUB_CONTENT_CLASS = MENU_CONTENT_CLASS;

/** 普通菜单项:h-8 / px-2 / rounded-lg / text-sm,focus(键盘)与 hover 同款高亮。 */
export const MENU_ITEM_CLASS =
  'flex h-8 cursor-pointer select-none items-center gap-2 rounded-lg px-2 text-sm outline-none text-[var(--cmd-palette-item-text)] transition-colors focus:bg-[var(--cmd-palette-item-hover)] data-[disabled]:pointer-events-none data-[disabled]:opacity-50';

/** 含子菜单的触发行:在 MENU_ITEM 基础上,展开态(data-state=open)也保持高亮。 */
export const MENU_ROW_CLASS =
  'flex h-8 cursor-pointer select-none items-center gap-2 rounded-lg px-2 text-sm outline-none text-[var(--cmd-palette-item-text)] transition-colors focus:bg-[var(--cmd-palette-item-hover)] data-[state=open]:bg-[var(--cmd-palette-item-hover)]';

/** 菜单分隔线。 */
export const MENU_SEPARATOR_CLASS = 'my-1 h-px bg-[var(--cmd-palette-border)]';
