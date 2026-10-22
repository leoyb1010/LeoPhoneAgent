/**
 * [leo] ⌥Space 快速派发浮窗(见 docs/specs/leo-quick-entry.md)。
 * 一行输入 + 工作区下拉;↩ 派发,⌘↩ 派发并打开,Esc 收起。派发成功显示「已派发」600ms 后收起。
 * 刻意不用 React:浮窗要在按下快捷键后立刻能打字,整页只有两个控件。
 */

interface LeoQuickPanelState {
  theme?: "light" | "dark" | "system";
  workspaces: string[];
  selected: string | null;
  error: string | null;
}

type DispatchResult = { ok: true; taskId: string } | { ok: false; error: string };

declare global {
  interface Window {
    leoQuickPanel?: {
      onState(callback: (state: LeoQuickPanelState) => void): () => void;
      dispatch(payload: { prompt: string; workspacePath: string | null; open: boolean }): Promise<DispatchResult>;
      hide(reason: "escape" | "dispatched"): void;
    };
  }
}

const HIDE_AFTER_DISPATCH_MS = 600;
// U+FE0E 让 ↩ 按文字字形显示,不被渲染成彩色 emoji。
const HINT = "↩\uFE0E 派发 · ⌘↩\uFE0E 派发并打开 · esc 收起";

const bridge = window.leoQuickPanel;
const input = document.getElementById("prompt") as HTMLInputElement;
const select = document.getElementById("workspace") as HTMLSelectElement;
const status = document.getElementById("status") as HTMLSpanElement;
let busy = false;
let hideTimer: number | null = null;

function setStatus(text: string, tone: "hint" | "ok" | "error" | "busy" = "hint") {
  status.textContent = text;
  status.dataset["tone"] = tone;
}

function leaf(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/**
 * [G3] 跟 App 外观走:浅色 / 深色时挂上和主窗口同名的 theme-zai-* 类(leo-tokens.css 与本页样式
 * 都按它取色);跟随系统时去掉类,回到 prefers-color-scheme。
 */
export function applyPanelTheme(root: HTMLElement, theme: LeoQuickPanelState["theme"]) {
  const explicit = theme === "light" || theme === "dark" ? theme : null;
  root.classList.toggle("theme-zai-light", explicit === "light");
  root.classList.toggle("theme-zai-dark", explicit === "dark");
  root.style.colorScheme = explicit ?? "light dark";
}

function renderWorkspaces(state: LeoQuickPanelState) {
  const current = select.value || state.selected;
  select.replaceChildren(
    ...state.workspaces.map((path) => {
      const option = document.createElement("option");
      option.value = path;
      option.textContent = leaf(path);
      option.title = path;
      return option;
    }),
  );
  if (state.workspaces.length === 0) {
    const option = document.createElement("option");
    option.textContent = "没有可用的工作区";
    option.value = "";
    select.append(option);
  }
  const preferred = current && state.workspaces.includes(current) ? current : (state.selected ?? "");
  select.value = preferred;
  select.disabled = state.workspaces.length === 0;
}

bridge?.onState((state) => {
  // 每次呼出:清掉上一轮的「已派发」,保留没发出去的草稿。
  if (hideTimer !== null) {
    window.clearTimeout(hideTimer);
    hideTimer = null;
  }
  applyPanelTheme(document.documentElement, state.theme);
  renderWorkspaces(state);
  if (!busy) {
    if (state.error) setStatus(`读不到工作区：${state.error}`, "error");
    else if (state.workspaces.length === 0) setStatus("先在 LeoBot 里打开一个项目", "busy");
    else setStatus(HINT);
  }
  document.body.classList.remove("shown");
  // 下一帧再加类名,让出现动画每次都从 0.98 开始。
  requestAnimationFrame(() => document.body.classList.add("shown"));
  input.focus();
  input.select();
});

async function dispatch(open: boolean) {
  const prompt = input.value.trim();
  if (!bridge || busy || !prompt) return;
  busy = true;
  setStatus("派发中…", "busy");
  const result = await bridge
    .dispatch({ prompt, workspacePath: select.value || null, open })
    .catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }));
  busy = false;
  if (!result.ok) {
    setStatus(`没派出去：${result.error}`, "error");
    input.focus();
    return;
  }
  input.value = "";
  if (open) return; // 主进程已收起浮窗并打开主窗口。
  setStatus("已派发", "ok");
  hideTimer = window.setTimeout(() => {
    hideTimer = null;
    setStatus(HINT);
    bridge.hide("dispatched");
  }, HIDE_AFTER_DISPATCH_MS);
}

window.addEventListener("keydown", (event) => {
  // 输入法组字中的回车是选词,不能当成派发。
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === "Escape") {
    event.preventDefault();
    bridge?.hide("escape");
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    void dispatch(event.metaKey);
  }
});

setStatus(HINT);
