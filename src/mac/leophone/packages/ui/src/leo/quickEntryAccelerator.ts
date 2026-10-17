/**
 * [leo] 设置页里录制 ⌥Space 快速派发的全局快捷键:把一次按键转成 Electron accelerator 字符串。
 * 主进程会再校验一遍(main/leo/quickPanelCore.ts),这里只负责「按了什么」与显示。
 */

interface AcceleratorKeyEvent {
  code: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const CODE_KEYS: Record<string, string> = {
  Space: "Space",
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
};

/**
 * 按物理键位(event.code)取主键:⌥ 组合在 macOS 上会把 event.key 变成 "≈"、"¬" 之类,不能用它。
 * 只按了修饰键返回 null(继续等);Esc 由调用方当成取消。
 */
export function acceleratorFromKeyEvent(event: AcceleratorKeyEvent): string | null {
  let key: string | undefined;
  if (/^Key[A-Z]$/.test(event.code)) key = event.code.slice(3);
  else if (/^Digit\d$/.test(event.code)) key = event.code.slice(5);
  else if (/^F\d{1,2}$/.test(event.code)) key = event.code;
  else key = CODE_KEYS[event.code];
  if (!key) return null;
  const parts: string[] = [];
  if (event.metaKey) parts.push("Command");
  if (event.ctrlKey) parts.push("Control");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  return [...parts, key].join("+");
}

const SYMBOLS: Record<string, string> = {
  Command: "⌘",
  CommandOrControl: "⌘",
  Control: "⌃",
  Alt: "⌥",
  Shift: "⇧",
  Enter: "↩",
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
};

export function formatAccelerator(accelerator: string): string {
  return accelerator
    .split("+")
    .map((part) => SYMBOLS[part] ?? part)
    .join("");
}

const MODIFIER_KEY: Record<string, string> = {
  Command: "Meta",
  CommandOrControl: "Meta",
  Control: "Control",
  Alt: "Alt",
  Shift: "Shift",
};

/**
 * [leo][WP-60] 按住说话:这次松开的是不是组合里的键(主键或任一修饰键)。
 * 主键按物理键位比(event.code),修饰键按 event.key 比。
 */
export function isAcceleratorRelease(
  event: Pick<AcceleratorKeyEvent, "code"> & { key: string },
  accelerator: string,
): boolean {
  const parts = accelerator.split("+");
  const main = parts.at(-1) ?? "";
  if (parts.slice(0, -1).some((modifier) => MODIFIER_KEY[modifier] === event.key)) return true;
  if (/^[A-Z]$/.test(main)) return event.code === `Key${main}`;
  if (/^\d$/.test(main)) return event.code === `Digit${main}`;
  if (/^F\d{1,2}$/.test(main)) return event.code === main;
  return CODE_KEYS[event.code] === main;
}
