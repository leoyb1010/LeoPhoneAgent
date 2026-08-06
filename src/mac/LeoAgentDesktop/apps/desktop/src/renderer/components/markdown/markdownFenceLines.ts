/**
 * markdownFenceLines — doc 模式 fenced code block(``` / ~~~)的整块行角色识别。
 *
 * 背景:PlaintextEditor 的 markdownLivePreviewPlugin 过去按"逐行正则"打行级
 * class,只有 ``` 标记行本身能拿到 cm-md-fence-line,围栏**内容行**被当成普通
 * markdown 渲染 —— 视觉上代码块断成"上下两个小卡片 + 中间裸文本",而且代码里
 * 的 `- ` / `**` / `---` 会被错误地做 bullet/加粗/分割线 conceal。
 *
 * 本模块对全文档做一次围栏配对扫描,给块内每一行标注角色:
 *   - 'first' — 开栏 ``` 行(卡片顶,圆角 + 上间距)
 *   - 'body'  — 围栏内容行(灰底 + 等宽,跳过一切 markdown conceal)
 *   - 'last'  — 收栏 ``` 行(卡片底)
 *
 * 围栏规则与 markdownImageLivePreview / markdownMermaidLivePreview 的简化
 * CommonMark 口径一致:开栏 = ≤3 空格缩进 + 3 个及以上 ` 或 ~;收栏 = 同字符、
 * 长度 ≥ 开栏、行内只有围栏字符和空白。**未闭合围栏保持保守策略**:不标注任何
 * 行(用户敲到一半时,下方内容不整片变灰),开栏行自身由调用方的逐行 fallback
 * (markdownLineClass)继续渲染成单行 fence 样式。
 *
 * 性能:调用方只在 docChanged 时重算(选区/视口变化复用缓存),扫描是每行一次
 * 正则的线性遍历,与 image / mermaid 两个 StateField 的既有扫描同量级。
 */

import type { Text as CodeMirrorText } from '@codemirror/state';

export type FenceLineRole = 'first' | 'body' | 'last';

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;

function buildFenceCloseRe(opener: string): RegExp {
  const ch = opener[0] === '`' ? '`' : '~';
  return new RegExp(`^ {0,3}${ch}{${opener.length},}\\s*$`);
}

/** 全文档扫描,返回 1-based 行号 → 围栏角色 的映射。 */
export function computeFenceLineRoles(doc: CodeMirrorText): Map<number, FenceLineRole> {
  const roles = new Map<number, FenceLineRole>();
  let lineNum = 1;
  while (lineNum <= doc.lines) {
    const open = FENCE_OPEN_RE.exec(doc.line(lineNum).text);
    if (!open) {
      lineNum++;
      continue;
    }
    const closeRe = buildFenceCloseRe(open[1]);
    let closeLine = -1;
    for (let j = lineNum + 1; j <= doc.lines; j++) {
      if (closeRe.test(doc.line(j).text)) {
        closeLine = j;
        break;
      }
    }
    // 未闭合围栏:整块不标注(保守,镜像 image/mermaid 扫描器),后续行也不再
    // 扫描 —— 它们都可能是"正在输入中的围栏体"。
    if (closeLine === -1) break;
    roles.set(lineNum, 'first');
    for (let j = lineNum + 1; j < closeLine; j++) roles.set(j, 'body');
    roles.set(closeLine, 'last');
    lineNum = closeLine + 1;
  }
  return roles;
}
