// ============================================================
// [leo] Read 的按模型行格式
// ============================================================
// - numbered（默认）：上游 cat -n 行号，逻辑不变；
// - hashline：读取逻辑同上游，只把显示换成 `行号#哈希:内容`（锚点给 Edit 用）；
// - plain：不带行号。按窗口读取：最多 2000 行 / 50KB，只在整行边界截断（绝不切半行），
//   还有剩余时在结果末尾给出 `[Showing lines X-Y of N. Use offset=Y+1 to continue.]`；
//   单行就超过 50KB 时不输出半行，改为提示用 Bash 截取。窗口按 range view 记入 read-state，
//   模型看到哪几行就能编辑哪几行，不会因为"没读全"被 Edit 拒绝。

import type {
  FileSystemPort,
  FileSystemReadTextRangeResult,
  ReadTextOutput,
  TraceContext,
} from "@zcode/contracts";
import { readTextFileForModel } from "../handlers/read-text.js";
import type { ReadFileStateEntry, ToolExecutionContext } from "../types.js";
import {
  getLeoToolProfile,
  LEO_PLAIN_READ_MAX_BYTES,
  LEO_PLAIN_READ_MAX_LINES,
} from "./tool-profile.js";

interface LeoReadTextOptions {
  abortSignal?: AbortSignal;
  filePath: string;
  fileSystemPort: FileSystemPort;
  limit?: number;
  offset?: number;
  onRead?: (read: FileSystemReadTextRangeResult) => void;
  trace?: TraceContext;
}

const BYTES_PER_KIB = 1024;

export async function readLeoTextFileForModel(
  context: ToolExecutionContext,
  options: LeoReadTextOptions,
): Promise<ReadTextOutput> {
  const format = getLeoToolProfile(context).readLineFormat;
  if (format === "plain") return readPlainWindow(options);
  const output = await readTextFileForModel(options);
  return format === "hashline" ? { ...output, lineFormat: "hashline" } : output;
}

/**
 * "文件未变，请看上次结果"的占位只在模型真的看过当前内容时才成立。hashline 模式下 Edit/Write 之后
 * read-state 由写工具更新，模型并没见过新的 行号#哈希，这时必须真的重读。
 */
export function leoAllowsUnchangedStub(
  context: ToolExecutionContext,
  cached: ReadFileStateEntry,
): boolean {
  if (getLeoToolProfile(context).readLineFormat !== "hashline") return true;
  return cached.sourceTool === undefined || cached.sourceTool === "Read";
}

/** plain 窗口被截断时，read-state 按实际给出的行数记成 range view（不是整文件读取）。 */
export function leoReadStateLimit(output: ReadTextOutput, limit: number | undefined): number | undefined {
  if (output.lineFormat !== "plain" || !output.truncated) return limit;
  return Math.max(1, output.numLines);
}

async function readPlainWindow(options: LeoReadTextOptions): Promise<ReadTextOutput> {
  const startIndex = options.offset === undefined || options.offset <= 1 ? 0 : options.offset - 1;
  const lineBudget = Math.min(options.limit ?? LEO_PLAIN_READ_MAX_LINES, LEO_PLAIN_READ_MAX_LINES);
  const read = await options.fileSystemPort.readTextFileRange(
    {
      path: options.filePath,
      offsetLine: startIndex,
      limitLines: lineBudget,
      trace: options.trace,
    },
    { signal: options.abortSignal },
  );
  options.onRead?.(read);

  const lines = read.lineCount === 0 ? [] : read.content.split("\n");
  let kept = 0;
  let bytes = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, "utf8") + (kept > 0 ? 1 : 0);
    if (bytes + lineBytes > LEO_PLAIN_READ_MAX_BYTES) break;
    bytes += lineBytes;
    kept += 1;
  }

  const base = {
    type: "text" as const,
    filePath: options.filePath,
    startLine: read.startLine,
    totalLines: read.totalLines,
    sizeBytes: read.sizeBytes,
    bytesRead: read.bytesRead,
    lineFormat: "plain" as const,
  };

  if (kept === 0 && lines.length > 0) {
    const firstLineBytes = Buffer.byteLength(lines[0] ?? "", "utf8");
    return {
      ...base,
      content: "",
      numLines: 0,
      truncated: true,
      partialViewNotice: `Line ${read.startLine} is ${Math.ceil(firstLineBytes / BYTES_PER_KIB)}KB, larger than the ${LEO_PLAIN_READ_MAX_BYTES / BYTES_PER_KIB}KB read window, so it is not shown (lines are never cut). View a slice with Bash, e.g. sed -n '${read.startLine}p' <file> | head -c ${LEO_PLAIN_READ_MAX_BYTES}, or search for the part you need.`,
    };
  }

  const endLine = read.startLine + kept - 1;
  return {
    ...base,
    content: lines.slice(0, kept).join("\n"),
    numLines: kept,
    truncated: endLine < read.totalLines,
  };
}
