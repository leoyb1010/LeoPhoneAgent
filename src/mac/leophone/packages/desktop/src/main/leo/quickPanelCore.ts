/**
 * [leo] 菜单栏 + ⌥Space 快速派发的纯逻辑(不引 electron,单测直接跑)。
 * 规则见 docs/specs/leo-quick-entry.md。
 */

export const DEFAULT_QUICK_ACCELERATOR = "Alt+Space";

export const QUICK_PANEL_SIZE = { width: 640, height: 128 } as const;

/** App 的外观选择(设置 → 外观):浅色 / 深色 / 跟随系统。 */
export type QuickPanelAppTheme = "light" | "dark" | "system";

export interface QuickEntrySettings {
  menuBarEnabled: boolean;
  quickPanelEnabled: boolean;
  accelerator: string;
  /**
   * [G3] 浮窗跟 App 外观走,不跟系统外观走。主窗口每次同步原生主题时记下来、落盘,
   * 下次启动主窗口还没同步之前呼出的浮窗也是对的。
   */
  appTheme: QuickPanelAppTheme;
}

export const DEFAULT_QUICK_ENTRY_SETTINGS: QuickEntrySettings = {
  menuBarEnabled: true,
  quickPanelEnabled: true,
  accelerator: DEFAULT_QUICK_ACCELERATOR,
  appTheme: "system",
};

export function parseQuickPanelAppTheme(raw: unknown): QuickPanelAppTheme | null {
  return raw === "light" || raw === "dark" || raw === "system" ? raw : null;
}

// ── 快捷键 ────────────────────────────────────────────────────────────────

const MODIFIERS = new Map<string, string>([
  ["command", "Command"],
  ["cmd", "Command"],
  ["commandorcontrol", "CommandOrControl"],
  ["cmdorctrl", "CommandOrControl"],
  ["control", "Control"],
  ["ctrl", "Control"],
  ["alt", "Alt"],
  ["option", "Alt"],
  ["shift", "Shift"],
]);
const MODIFIER_ORDER = ["Command", "CommandOrControl", "Control", "Alt", "Shift"];
const NAMED_KEYS = new Map<string, string>(
  [
    "Space",
    "Tab",
    "Enter",
    "Backspace",
    "Delete",
    "Up",
    "Down",
    "Left",
    "Right",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Escape",
    "Plus",
    ...Array.from({ length: 20 }, (_, index) => `F${index + 1}`),
  ].map((key) => [key.toLowerCase(), key]),
);
const PUNCTUATION = new Set([",", ".", "/", ";", "'", "[", "]", "\\", "-", "=", "`"]);

/**
 * 系统级组合(Spotlight、切输入法、切 App、截屏、强制退出、表情面板)。globalShortcut 会照样注册成功,
 * 把它们从系统手里抢走,所以这里直接拒绝。
 */
const RESERVED_ACCELERATORS = new Set([
  "Command+Space",
  "Control+Space",
  "Command+Alt+Space",
  "Control+Alt+Space",
  "Command+Control+Space",
  "Command+Tab",
  "Command+Alt+Escape",
  "Command+Control+Q",
  "Command+Shift+3",
  "Command+Shift+4",
  "Command+Shift+5",
]);

type AcceleratorCheck = { ok: true; accelerator: string } | { ok: false; reason: string };

/**
 * 全局快捷键校验并规范化成 Electron accelerator:必须带 ⌘ / ⌃ / ⌥ 至少一个(只有 Shift 会吃掉正常输入),
 * 恰好一个主键;F 键可以不带修饰键。
 */
export function validateQuickAccelerator(raw: unknown): AcceleratorCheck {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, reason: "快捷键是空的" };
  // Electron 里加号键写作 "Plus",所以按 "+" 拆分不会有歧义。
  const parts = raw.split("+").map((part) => part.trim());
  const modifiers = new Set<string>();
  let key: string | null = null;
  for (const part of parts) {
    if (!part) return { ok: false, reason: "快捷键格式不对" };
    const modifier = MODIFIERS.get(part.toLowerCase());
    if (modifier) {
      modifiers.add(modifier);
      continue;
    }
    if (key) return { ok: false, reason: "只能有一个主键" };
    const named = NAMED_KEYS.get(part.toLowerCase());
    if (named) key = named;
    else if (/^[a-z0-9]$/i.test(part)) key = part.toUpperCase();
    else if (PUNCTUATION.has(part)) key = part;
    else return { ok: false, reason: `不认识的按键：${part}` };
  }
  if (!key) return { ok: false, reason: "缺少主键" };
  const isFunctionKey = /^F\d{1,2}$/.test(key);
  const hasRealModifier = [...modifiers].some((modifier) => modifier !== "Shift");
  if (!hasRealModifier && !isFunctionKey) return { ok: false, reason: "需要至少一个 ⌘ / ⌃ / ⌥ 修饰键" };
  if (modifiers.has("Command") && modifiers.has("CommandOrControl"))
    return { ok: false, reason: "快捷键格式不对" };
  const ordered = MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier));
  const accelerator = [...ordered, key].join("+");
  if (RESERVED_ACCELERATORS.has(accelerator.replace("CommandOrControl", "Command")))
    return { ok: false, reason: "这是系统快捷键，换一个" };
  // 只带 ⌘(或 ⌘⇧)的字母数字键是各个 App 自己的命令(⌘C、⌘S、⌘⇧N…),全局抢走会让它们全部失灵。
  const commandOnly = ordered.every((modifier) => modifier === "Command" || modifier === "CommandOrControl" || modifier === "Shift");
  if (commandOnly && ordered.some((modifier) => modifier !== "Shift") && key.length === 1)
    return { ok: false, reason: "⌘ 加单个键会和各个 App 自己的快捷键冲突，再加上 ⌃ 或 ⌥" };
  return { ok: true, accelerator };
}

/** 菜单与设置里显示用的 macOS 符号写法:Control+Alt+L → ⌃⌥L。 */
export function formatAcceleratorLabel(accelerator: string): string {
  const symbols: Record<string, string> = {
    Command: "⌘",
    CommandOrControl: "⌘",
    Control: "⌃",
    Alt: "⌥",
    Shift: "⇧",
    Space: "Space",
    Enter: "↩",
    Backspace: "⌫",
    Escape: "⎋",
    Up: "↑",
    Down: "↓",
    Left: "←",
    Right: "→",
  };
  return accelerator
    .split("+")
    .map((part) => symbols[part] ?? part)
    .join("");
}

export function parseQuickEntrySettings(raw: unknown): QuickEntrySettings {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const accelerator = validateQuickAccelerator(value["accelerator"]);
  return {
    menuBarEnabled: value["menuBarEnabled"] !== false,
    quickPanelEnabled: value["quickPanelEnabled"] !== false,
    accelerator: accelerator.ok ? accelerator.accelerator : DEFAULT_QUICK_ACCELERATOR,
    appTheme: parseQuickPanelAppTheme(value["appTheme"]) ?? "system",
  };
}

// ── 浮窗定位 ──────────────────────────────────────────────────────────────

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 浮窗出现在鼠标所在屏幕(按 bounds 判定;鼠标落在屏幕缝隙时取最近的屏)的工作区里,
 * 水平居中、顶边在工作区高度 1/3 处往上半个窗口(视觉重心在上 1/3);窗口不出工作区。
 */
export function computeQuickPanelBounds(
  cursor: { x: number; y: number },
  displays: ReadonlyArray<{ bounds: Rect; workArea: Rect }>,
  size: { width: number; height: number } = QUICK_PANEL_SIZE,
): Rect {
  if (displays.length === 0) return { x: 0, y: 0, ...size };
  const contains = (rect: Rect) =>
    cursor.x >= rect.x && cursor.x < rect.x + rect.width && cursor.y >= rect.y && cursor.y < rect.y + rect.height;
  const distance = (rect: Rect) => {
    const dx = Math.max(rect.x - cursor.x, 0, cursor.x - (rect.x + rect.width - 1));
    const dy = Math.max(rect.y - cursor.y, 0, cursor.y - (rect.y + rect.height - 1));
    return dx * dx + dy * dy;
  };
  const display =
    displays.find((candidate) => contains(candidate.bounds)) ??
    [...displays].sort((a, b) => distance(a.bounds) - distance(b.bounds))[0]!;
  const area = display.workArea;
  const width = Math.min(size.width, area.width);
  const height = Math.min(size.height, area.height);
  const x = Math.round(area.x + (area.width - width) / 2);
  const preferredY = Math.round(area.y + area.height / 3 - height / 2);
  const y = Math.min(Math.max(preferredY, area.y), area.y + area.height - height);
  return { x, y, width, height };
}

// ── 菜单栏 ────────────────────────────────────────────────────────────────

export interface QuickTaskRowView {
  taskId: string;
  title: string;
  workspacePath: string;
  workspaceIdentity?: string;
  state: "waiting" | "running" | "error" | "done" | "idle";
  updatedAt: number;
}

export interface QuickSummaryView {
  waiting: QuickTaskRowView[];
  running: QuickTaskRowView[];
  recent: QuickTaskRowView[];
  workspaces: string[];
}

/**
 * 有任务在跑或在等你时 8 秒刷一次,其余 15 秒;读不到 Host 时 10 秒后再试。
 * 以前 3 秒一次 listTaskList,长任务跑着时 Host 一直被轮询;菜单栏数字晚几秒无所谓,打开菜单时会现读。
 */
export function nextSummaryPollDelay(summary: QuickSummaryView | null): number {
  if (!summary) return 10_000;
  return summary.running.length > 0 || summary.waiting.length > 0 ? 8_000 : 15_000;
}

/** 菜单栏图标旁的数字:只在有任务在跑时显示运行数。 */
export function trayTitle(summary: QuickSummaryView | null): string {
  const running = summary?.running.length ?? 0;
  return running > 0 ? String(running) : "";
}

type QuickTrayMenuItem =
  | { kind: "header"; label: string }
  | { kind: "task"; label: string; taskId: string; workspacePath: string; workspaceIdentity?: string }
  | { kind: "info"; label: string }
  | { kind: "separator" }
  | { kind: "new-task"; label: string; accelerator?: string }
  | { kind: "open-app"; label: string }
  | { kind: "quit"; label: string };

const STATE_LABEL: Record<QuickTaskRowView["state"], string> = {
  waiting: "等你确认",
  running: "在跑",
  error: "出错待看",
  done: "做完待看",
  idle: "",
};

function truncate(text: string, max = 36): string {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
}

function projectOf(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

export function buildQuickTrayMenu(
  summary: QuickSummaryView | null,
  options: { accelerator?: string; quickPanelEnabled: boolean; hostError?: string },
): QuickTrayMenuItem[] {
  const items: QuickTrayMenuItem[] = [];
  if (!summary) {
    items.push({ kind: "info", label: options.hostError ? `读不到任务：${options.hostError}` : "正在读取任务…" });
  } else {
    const row = (task: QuickTaskRowView): QuickTrayMenuItem => {
      const suffix = STATE_LABEL[task.state];
      return {
        kind: "task",
        taskId: task.taskId,
        workspacePath: task.workspacePath,
        ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
        label: `${truncate(task.title)} · ${projectOf(task.workspacePath)}${suffix ? ` · ${suffix}` : ""}`,
      };
    };
    if (summary.waiting.length > 0) {
      items.push({ kind: "header", label: `待审批 ${summary.waiting.length}` }, ...summary.waiting.map(row));
    }
    items.push({ kind: "header", label: summary.running.length > 0 ? `运行中 ${summary.running.length}` : "没有在跑的任务" });
    items.push(...summary.running.map(row));
    const shown = new Set([...summary.waiting, ...summary.running].map((task) => task.taskId));
    const recent = summary.recent.filter((task) => !shown.has(task.taskId));
    if (recent.length > 0) items.push({ kind: "header", label: "最近" }, ...recent.map(row));
  }
  items.push({ kind: "separator" });
  if (options.quickPanelEnabled) {
    items.push({ kind: "new-task", label: "新任务…", ...(options.accelerator ? { accelerator: options.accelerator } : {}) });
  }
  items.push({ kind: "open-app", label: "打开 LeoBot" }, { kind: "separator" }, { kind: "quit", label: "退出 LeoBot" });
  return items;
}
