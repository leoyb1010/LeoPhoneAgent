import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal as XTerm } from "@xterm/xterm";

import { logger } from "@/logger.js";

/**
 * [leo] 终端增强(WP-24):xterm 5.5 官方 addon —— 搜索、WebGL 渲染、Unicode 11 字宽。
 *
 * 每个 xterm 实例只挂一次(侧栏终端的实例会跨组件复用,所以用 WeakMap 记);addon 随 term.dispose() 一起释放。
 * WebGL 失败或上下文丢失(外接显示器驱动、同时开太多终端超过 Chromium 的上下文上限)时 dispose 掉,
 * xterm 自动回到默认的 DOM 渲染;本次运行之后新开的终端也不再尝试。`localStorage["leo.terminal.webgl"]="off"` 可整体关掉。
 */

interface TerminalEnhancements {
  search: SearchAddon;
}

const enhanced = new WeakMap<XTerm, TerminalEnhancements>();
let webglUnavailable = false;

function webglDisabledByUser(): boolean {
  try {
    return window.localStorage.getItem("leo.terminal.webgl") === "off";
  } catch {
    return false;
  }
}

function tryWebgl(term: XTerm): void {
  if (webglUnavailable || webglDisabledByUser()) return;
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      // 上下文丢了就别再救:dispose 后 xterm 回到 DOM 渲染,内容与滚动位置不受影响。
      webglUnavailable = true;
      logger.warn("[Terminal] WebGL context lost, falling back to DOM renderer");
      webgl.dispose();
    });
    term.loadAddon(webgl);
  } catch (error) {
    webglUnavailable = true;
    logger.warn("[Terminal] WebGL renderer unavailable, using DOM renderer", error);
  }
}

/** 必须在 term.open() 之后调用(WebGL 要拿到 DOM 里的 canvas)。重复调用返回同一份。 */
export function ensureTerminalEnhancements(term: XTerm): TerminalEnhancements {
  const existing = enhanced.get(term);
  if (existing) return existing;
  try {
    term.loadAddon(new Unicode11Addon());
    // 中文、emoji 按 Unicode 11 的宽度表算列宽,光标不再错位。
    term.unicode.activeVersion = "11";
  } catch (error) {
    logger.warn("[Terminal] unicode11 addon failed", error);
  }
  const search = new SearchAddon();
  term.loadAddon(search);
  tryWebgl(term);
  const result = { search };
  enhanced.set(term, result);
  return result;
}

export function getTerminalEnhancements(term: XTerm | null): TerminalEnhancements | null {
  return term ? (enhanced.get(term) ?? null) : null;
}

const BRAND = "#2e9c9c";

/** 把品牌色按比例叠到终端背景上,得到「brand-soft」的不透明 #RRGGBB(搜索高亮只认这种格式)。 */
function mixHex(background: string | undefined, foreground: string, ratio: number): string {
  const parse = (hex: string | undefined) => {
    const match = /^#([0-9a-f]{6})$/i.exec(hex?.trim() ?? "");
    if (!match) return null;
    const value = Number.parseInt(match[1]!, 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255] as const;
  };
  const bg = parse(background);
  const fg = parse(foreground);
  if (!fg) return foreground;
  if (!bg) return foreground;
  const channel = (index: 0 | 1 | 2) => Math.round(bg[index] * (1 - ratio) + fg[index] * ratio);
  return `#${[channel(0), channel(1), channel(2)].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export function terminalSearchOptions(term: XTerm): ISearchOptions {
  const background = term.options.theme?.background;
  return {
    decorations: {
      matchBackground: mixHex(background, BRAND, 0.28),
      matchOverviewRuler: BRAND,
      activeMatchBackground: mixHex(background, BRAND, 0.6),
      activeMatchColorOverviewRuler: BRAND,
    },
  };
}
