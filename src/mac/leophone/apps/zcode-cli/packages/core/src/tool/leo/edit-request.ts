// ============================================================
// [leo] Edit 入参 → 编辑请求
// ============================================================
// 单段形态（顶层 old_string/new_string，或只有一段文本替换的 edits[]）交回上游原逻辑，
// 保持上游全部错误文案与特例（old_string 为空时创建文件、replace_all 等）。
// 其余（多段、hashline 锚点）走 leo/edit-plan.ts。

import {
  LeoEditErrorCode,
  LeoEditInputSchema,
  type LeoEditInput,
  type LeoEditItemInput,
  type LeoHashlineEditOp,
} from "@zcode/contracts";
import { stripHashlinePrefixesFromLines } from "./hashline.js";

export type LeoEditOperation =
  | { kind: "text"; index: number; oldString: string; newString: string; replaceAll: boolean }
  | {
      kind: "anchor";
      index: number;
      op: LeoHashlineEditOp;
      pos?: string;
      end?: string;
      lines: string[];
    };

export interface LeoSingleEdit {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all: boolean;
}

export type LeoEditRequest =
  | { ok: true; filePath: string; single: LeoSingleEdit; multi?: undefined }
  | { ok: true; filePath: string; single?: undefined; multi: LeoEditOperation[] }
  | { ok: false; filePath?: string; errorCode: number; message: string };

const OPS_WITHOUT_POSITION: ReadonlySet<LeoHashlineEditOp> = new Set(["append", "prepend"]);

export function parseLeoEditRequest(input: unknown): LeoEditRequest {
  return toLeoEditRequest(LeoEditInputSchema.parse(input));
}

export function toLeoEditRequest(input: LeoEditInput): LeoEditRequest {
  const filePath = input.file_path;
  const edits = input.edits ?? [];
  if (edits.length === 0) {
    if (typeof input.old_string !== "string" || typeof input.new_string !== "string") {
      return invalid(
        filePath,
        "Edit needs old_string and new_string, or a non-empty edits array.",
      );
    }
    return {
      ok: true,
      filePath,
      single: {
        file_path: filePath,
        old_string: input.old_string,
        new_string: input.new_string,
        replace_all: input.replace_all ?? false,
      },
    };
  }

  const onlyItem = edits.length === 1 ? edits[0] : undefined;
  if (onlyItem && isPlainTextItem(onlyItem)) {
    // 只有一段文本替换：等价于上游单段调用（包括 old_string 为空时创建文件）。
    return {
      ok: true,
      filePath,
      single: {
        file_path: filePath,
        old_string: onlyItem.old_string,
        new_string: onlyItem.new_string,
        replace_all: onlyItem.replace_all ?? input.replace_all ?? false,
      },
    };
  }

  const operations: LeoEditOperation[] = [];
  const problems: string[] = [];
  edits.forEach((item, index) => {
    const operation = toOperation(item, index, input.replace_all ?? false);
    if (typeof operation === "string") problems.push(operation);
    else operations.push(operation);
  });
  if (problems.length > 0) return invalid(filePath, problems.join("\n"));
  return { ok: true, filePath, multi: operations };
}

function isPlainTextItem(
  item: LeoEditItemInput,
): item is LeoEditItemInput & { old_string: string; new_string: string } {
  return (
    typeof item.old_string === "string" &&
    typeof item.new_string === "string" &&
    item.op === undefined &&
    item.pos === undefined &&
    item.end === undefined &&
    item.lines === undefined
  );
}

function toOperation(
  item: LeoEditItemInput,
  index: number,
  defaultReplaceAll: boolean,
): LeoEditOperation | string {
  const label = `edits[${index}]`;
  const hasText = item.old_string !== undefined || item.new_string !== undefined;
  const hasAnchor =
    item.op !== undefined ||
    item.pos !== undefined ||
    item.end !== undefined ||
    item.lines !== undefined;

  if (hasText && hasAnchor) {
    return `${label} mixes old_string/new_string with anchor fields (op/pos/end/lines); use one form per edit.`;
  }
  if (hasText) {
    if (typeof item.old_string !== "string" || typeof item.new_string !== "string") {
      return `${label} needs both old_string and new_string.`;
    }
    if (item.old_string === "") {
      return `${label}.old_string must not be empty in a multi-edit call (use Write to create a file).`;
    }
    return {
      kind: "text",
      index,
      oldString: item.old_string,
      newString: item.new_string,
      replaceAll: item.replace_all ?? defaultReplaceAll,
    };
  }
  if (!hasAnchor) {
    return `${label} is empty: give old_string/new_string, or pos (+ end) with lines.`;
  }

  const op = item.op ?? (item.pos !== undefined ? "replace" : undefined);
  if (!op) return `${label} needs op or pos.`;
  if (!OPS_WITHOUT_POSITION.has(op) && item.pos === undefined) {
    return `${label} (${op}) needs pos, a "LINE#HASH" anchor copied from Read output.`;
  }
  if (item.lines === undefined && op !== "delete") {
    return `${label} (${op}) needs lines (use op "delete" or an empty lines array to remove lines).`;
  }
  return {
    kind: "anchor",
    index,
    op,
    ...(item.pos === undefined ? {} : { pos: item.pos }),
    ...(item.end === undefined ? {} : { end: item.end }),
    lines: normalizeAnchorLines(item.lines),
  };
}

/** 行数组归一：去 \r、把含换行的元素拆开、剥掉整体带 `12#VK:` 前缀的抄写。 */
function normalizeAnchorLines(lines: LeoEditItemInput["lines"]): string[] {
  if (lines === undefined) return [];
  const raw = typeof lines === "string" ? [lines] : lines;
  const flattened = raw.flatMap((line) => line.replaceAll("\r\n", "\n").replaceAll("\r", "").split("\n"));
  return stripHashlinePrefixesFromLines(flattened);
}

function invalid(filePath: string | undefined, message: string): LeoEditRequest {
  return {
    ok: false,
    ...(filePath === undefined ? {} : { filePath }),
    errorCode: LeoEditErrorCode.INVALID_EDITS,
    message,
  };
}
