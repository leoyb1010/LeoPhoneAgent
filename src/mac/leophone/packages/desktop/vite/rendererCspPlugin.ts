import type { Plugin } from "vite";

/**
 * [leo] 主窗口生产 CSP（契约见 docs/specs/desktop-renderer-boundary.md §1）。
 *
 * 根因：主窗口带完整 preload（window.zcode、Host MessagePort），又要渲染模型回复、Markdown、工具结果
 * 这类不可信内容。之前没有任何 CSP，一旦出现脚本注入就能直接驱动 Agent。
 *
 * - 只在 `vite build` 时注入（apply: "build"）：dev server 的 HMR 与 React Refresh 依赖内联 preamble，开发不受影响。
 * - 只处理主窗口 index.html；其它窗口和插件沙箱 shell 不经这里（插件 UI 走 zcode-sandbox 的 header CSP）。
 * - 脚本不放 'unsafe-inline' / 'unsafe-eval'：启动壳脚本已移到 startupShell.ts。'wasm-unsafe-eval' 只允许编译
 *   WebAssembly（shiki oniguruma 引擎），不开放字符串 eval。
 * - 样式保留 'unsafe-inline'：React style 属性和 katex / mermaid / xterm 的运行时 <style> 注入确实需要。
 */
export const RENDERER_PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: file: zcode-media: https: http:",
  "media-src 'self' data: blob: file: zcode-media: https: http:",
  "font-src 'self' data:",
  "connect-src 'self' data: blob: file: zcode-media: zcode-sandbox: https: http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*",
  "frame-src 'self' zcode-sandbox: blob: file: https: http:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const MAIN_WINDOW_HTML = /(^|[\\/])index\.html$/;

export function rendererCspPlugin(): Plugin {
  return {
    name: "leo-renderer-csp",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html, context) {
        if (!MAIN_WINDOW_HTML.test(context.filename)) return html;
        return [
          {
            tag: "meta",
            attrs: { "http-equiv": "Content-Security-Policy", content: RENDERER_PRODUCTION_CSP },
            injectTo: "head-prepend",
          },
        ];
      },
    },
  };
}
