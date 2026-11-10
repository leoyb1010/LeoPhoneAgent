// [leo] 主窗口启动壳脚本：原先内联在 index.html 里。根因：主窗口要上不含 'unsafe-inline' 的生产 CSP，
// 内联脚本会被拦住，启动壳永远盖在界面上。移到自有模块文件，行为与原内联脚本一致。
// 必须在 main.tsx 之前加载（index.html 里排在前面），才能在 React 派发 zcode-react-startup-ready 前挂好监听。
export {};

const startupLogoShell = document.querySelector(".startup-logo-shell");
const startupLoading = document.getElementById("loading");
const isUpdateStatusWindow =
  new URLSearchParams(window.location.search).get("windowKind") === "update-status";
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let finished = false;
let animationDone = false;
let reactReady = false;

// 修复原因：主入口不能依赖动画结束后的动态 import；一旦导入路径在 Electron/Vite 下失败，
// 页面会永久停在 HTML loading。这里让主入口静态加载，只把启动壳作为动画遮罩延迟移除。
const tryFinishStartupAnimation = () => {
  if (finished || !animationDone || !reactReady) return;
  finished = true;
  document.body.classList.add("zcode-startup-ready");
  window.setTimeout(() => startupLoading?.remove(), 500);
};

const markAnimationDone = () => {
  animationDone = true;
  tryFinishStartupAnimation();
};

const markReactReady = () => {
  reactReady = true;
  tryFinishStartupAnimation();
};

if (isUpdateStatusWindow) {
  // Bugfix: 更新状态窗口本身就是一个轻量弹窗，复用主入口 HTML 时不应再显示启动壳。
  // 否则透明独立窗口里的启动 logo 会短暂或持续盖在更新按钮上，看起来像弹窗 UI 异常。
  finished = true;
  document.body.classList.add("zcode-startup-ready");
  startupLoading?.remove();
} else {
  window.addEventListener("zcode-react-startup-ready", markReactReady, { once: true });
}

if (isUpdateStatusWindow || reduceMotion || !startupLogoShell) {
  markAnimationDone();
} else {
  startupLogoShell.addEventListener("animationend", markAnimationDone, { once: true });
  window.setTimeout(markAnimationDone, 1000);
}

if (!isUpdateStatusWindow) {
  window.setTimeout(markReactReady, 3000);
}
