import "./leo-skin.css";

/**
 * [leo] 皮肤开关。模块加载即生效(由 LeoWhatsNew 引入,早于首屏渲染)。
 * 出问题时在开发者工具里执行 localStorage.setItem("leo.skin", "off") 后重开窗口,即回到上游外观。
 */
const LEO_SKIN_STORAGE_KEY = "leo.skin";

function leoSkinDisabled(): boolean {
  try {
    return window.localStorage.getItem(LEO_SKIN_STORAGE_KEY) === "off";
  } catch {
    return false;
  }
}

export function applyLeoSkin(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (leoSkinDisabled()) {
    root.removeAttribute("data-leo-skin");
    return;
  }
  root.setAttribute("data-leo-skin", "quiet");
}

applyLeoSkin();
