// ============================================================
// [leo] Read 正文的按模型显示（hashline / plain）
// ============================================================
// 从 handlers/read-text.ts 的 formatReadTextOutput 调用；单独成文件以免 read-text ↔ read-format 循环依赖。

import type { ReadTextOutput } from "@zcode/contracts";
import { formatHashlineContent } from "./hashline.js";

/**
 * formatReadTextOutput 的 [leo] 分支：hashline / plain 返回模型可见正文；numbered 返回 undefined，
 * 交回上游 cat -n 逻辑。空内容也交回上游（空文件、offset 越界的提醒）。
 */
export function formatLeoReadTextBody(output: ReadTextOutput): string | undefined {
  if (output.lineFormat === "hashline") {
    if (!output.content) return undefined;
    return formatHashlineContent(output.content, Math.max(1, output.startLine));
  }
  if (output.lineFormat !== "plain") return undefined;
  if (!output.content) return output.partialViewNotice ? "" : undefined;
  const endLine = output.startLine + output.numLines - 1;
  if (endLine >= output.totalLines) return output.content;
  return `${output.content}\n\n[Showing lines ${output.startLine}-${endLine} of ${output.totalLines}. Use offset=${endLine + 1} to continue.]`;
}
