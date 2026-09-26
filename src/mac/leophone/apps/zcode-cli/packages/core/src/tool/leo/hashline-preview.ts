// ============================================================
// [leo] hashline 模式的编辑结果预览
// ============================================================
// 编辑后行号会整体移动，模型手里的旧锚点随之失效。Edit 的结果里附上改动附近（diff 的新文件一侧，
// 含上下文行）的最新 `行号#哈希:内容`，模型可以直接接着编辑，不必为了拿锚点再 Read 一遍。

import { createStructuredPatch } from "../diff.js";
import { formatLineTag } from "./hashline.js";

const PREVIEW_MAX_LINES = 60;
const DIFF_PREVIEW_PATH = "file";

export function buildLeoHashlinePreview(oldContent: string, newContent: string): string {
  const hunks = createStructuredPatch({
    filePath: DIFF_PREVIEW_PATH,
    oldContent,
    newContent,
  });
  const newLines = newContent.split("\n");
  const output: string[] = [];
  let shown = 0;
  let previousEnd = 0;
  for (const hunk of hunks) {
    const start = Math.max(1, hunk.newStart);
    const end = Math.min(newLines.length, hunk.newStart + Math.max(hunk.newLines, 1) - 1);
    if (output.length > 0 && start > previousEnd + 1) output.push("...");
    for (let line = Math.max(start, previousEnd + 1); line <= end; line += 1) {
      if (shown >= PREVIEW_MAX_LINES) {
        output.push("... (preview truncated; Read the file for the rest)");
        return output.join("\n");
      }
      const text = newLines[line - 1] ?? "";
      output.push(`${formatLineTag(line, text)}:${text}`);
      shown += 1;
    }
    previousEnd = Math.max(previousEnd, end);
  }
  return output.join("\n");
}

/** 单段编辑（走上游路径）在 hashline 模式下也附上新锚点；replace 模式返回 undefined，输出不变。 */
export function leoSingleEditSummary(
  mode: "replace" | "hashline",
  strategy: string,
  oldContent: string,
  newContent: string,
): { editCount: number; strategies: string[]; mode: "hashline"; preview: string } | undefined {
  if (mode !== "hashline") return undefined;
  return {
    editCount: 1,
    strategies: [strategy],
    mode,
    preview: buildLeoHashlinePreview(oldContent, newContent),
  };
}
