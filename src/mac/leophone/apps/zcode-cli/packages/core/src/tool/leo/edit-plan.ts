// ============================================================
// [leo] 多段 / hashline 编辑的匹配与拼接
// ============================================================
// 所有编辑都针对同一份原始内容（已去掉 BOM、LF 行尾）定位成字符区间，校验互不重叠后
// 一次性从左到右拼出新内容：要么全部生效，要么一个都不生效。
//   - 文本替换沿用上游 findEditMatch 的策略链（exact → [leo] 窄归一化 → 上游宽松匹配器），
//     每段必须唯一（replace_all 除外）；
//   - hashline 锚点先全部校验哈希，任一不符就整体拒绝并回显正确锚点。
// 多段编辑的做法参考 pi coding agent 的 applyEditsToNormalizedContent（MIT, Copyright (c) 2025
// Mario Zechner）：先全部匹配原文、按位置排序、拒绝重叠、再统一应用。

import { EditErrorCode, LeoEditErrorCode } from "@zcode/contracts";
import { findEditMatch, normalizeLineEndings, normalizeReplacementForMatch, preserveQuoteStyle } from "../edit-matchers.js";
import type { LeoEditOperation } from "./edit-request.js";
import type { LeoEditMode } from "./model-profile.js";
import { buildLeoHashlinePreview } from "./hashline-preview.js";
import {
  computeLineHash,
  formatAnchorProblems,
  parseHashlineAnchor,
  type HashlineAnchor,
  type HashlineAnchorProblem,
} from "./hashline.js";

export const LEO_HASHLINE_ANCHOR_STRATEGY = "hashline_anchor";
const SEGMENT_SEPARATOR = "\n…\n";

interface PlannedRange {
  start: number;
  end: number;
  text: string;
  index: number;
}

export interface LeoEditPlanSuccess {
  ok: true;
  newContent: string;
  /** 每段编辑实际命中的策略（按 edits[] 顺序）；锚点操作记为 hashline_anchor。 */
  strategies: string[];
  /** 输出里的 oldString/newString：各段原文 / 新文本用 … 连接，只作展示。 */
  oldString: string;
  newString: string;
  /** hashline 模式下改动附近的新锚点，供模型继续编辑而不必重读。 */
  preview?: string;
}

export interface LeoEditPlanFailure {
  ok: false;
  errorCode: number;
  message: string;
}

export type LeoEditPlanResult = LeoEditPlanSuccess | LeoEditPlanFailure;

export function planLeoMultiEdit(input: {
  content: string;
  operations: readonly LeoEditOperation[];
  mode: LeoEditMode;
}): LeoEditPlanResult {
  const { content, operations } = input;
  const strategies: string[] = Array.from({ length: operations.length }, () => "");
  const ranges: PlannedRange[] = [];

  const anchorResult = planAnchorOperations(content, operations, strategies);
  if (!anchorResult.ok) return anchorResult;
  ranges.push(...anchorResult.ranges);

  const textResult = planTextOperations(content, operations, strategies);
  if (!textResult.ok) return textResult;
  ranges.push(...textResult.ranges);

  ranges.sort((left, right) => left.start - right.start || left.end - right.end || left.index - right.index);
  for (let position = 1; position < ranges.length; position += 1) {
    const previous = ranges[position - 1]!;
    const current = ranges[position]!;
    if (previous.end > current.start) {
      return {
        ok: false,
        errorCode: LeoEditErrorCode.OVERLAPPING_EDITS,
        message: `edits[${previous.index}] and edits[${current.index}] overlap. Merge them into one edit or target disjoint regions; no changes were made.`,
      };
    }
  }

  let newContent = "";
  let cursor = 0;
  for (const range of ranges) {
    newContent += content.slice(cursor, range.start) + range.text;
    cursor = range.end;
  }
  newContent += content.slice(cursor);

  if (newContent === content) {
    return {
      ok: false,
      errorCode: EditErrorCode.NO_CHANGE,
      message: "No changes to make: the edits produce identical content.",
    };
  }

  return {
    ok: true,
    newContent,
    strategies,
    oldString: ranges.map((range) => content.slice(range.start, range.end)).join(SEGMENT_SEPARATOR),
    newString: ranges.map((range) => range.text).join(SEGMENT_SEPARATOR),
    ...(input.mode === "hashline" ? { preview: buildLeoHashlinePreview(content, newContent) } : {}),
  };
}

// -----------------------------------------------
// 文本替换
// -----------------------------------------------

function planTextOperations(
  content: string,
  operations: readonly LeoEditOperation[],
  strategies: string[],
): { ok: true; ranges: PlannedRange[] } | LeoEditPlanFailure {
  const ranges: PlannedRange[] = [];
  const notFound: string[] = [];
  const ambiguous: string[] = [];

  for (const operation of operations) {
    if (operation.kind !== "text") continue;
    const label = `edits[${operation.index}]`;
    const search = normalizeLineEndings(operation.oldString);
    const requestedNew = normalizeLineEndings(operation.newString);
    const match = findEditMatch({ content, search, replaceAll: operation.replaceAll });
    if (match.status === "not_found") {
      notFound.push(`${label}: old_string not found in file.\nString: ${operation.oldString}`);
      continue;
    }
    if (match.status === "ambiguous") {
      ambiguous.push(
        `${label}: found ${match.candidateCount} different matches for old_string. Provide more surrounding context to make it unique.\nString: ${operation.oldString}`,
      );
      continue;
    }

    const actual = match.actualString;
    const positions = findAllPositions(content, actual);
    if (!operation.replaceAll && positions.length > 1) {
      ambiguous.push(
        `${label}: found ${positions.length} matches of old_string, but replace_all is false. Provide more context to identify one occurrence, or set replace_all.\nString: ${operation.oldString}`,
      );
      continue;
    }

    const replacement = preserveQuoteStyle(
      search,
      actual,
      normalizeReplacementForMatch(match.strategy, requestedNew),
    );
    strategies[operation.index] = match.strategy;
    for (const start of positions) {
      let end = start + actual.length;
      // 与上游单段删除一致：删除整行内容时连同其后的换行一起删，避免留下空行。
      if (replacement === "" && !actual.endsWith("\n") && content[end] === "\n") end += 1;
      ranges.push({ start, end, text: replacement, index: operation.index });
    }
  }

  if (notFound.length > 0 || ambiguous.length > 0) {
    return {
      ok: false,
      errorCode:
        notFound.length > 0 ? EditErrorCode.OLD_STRING_NOT_FOUND : EditErrorCode.AMBIGUOUS_REPLACE,
      message: [...notFound, ...ambiguous, "No changes were made; fix these edits and retry."].join(
        "\n\n",
      ),
    };
  }
  return { ok: true, ranges };
}

function findAllPositions(content: string, needle: string): number[] {
  const positions: number[] = [];
  if (needle.length === 0) return positions;
  let position = 0;
  while (position <= content.length) {
    const index = content.indexOf(needle, position);
    if (index === -1) break;
    positions.push(index);
    position = index + needle.length;
  }
  return positions;
}

// -----------------------------------------------
// hashline 锚点
// -----------------------------------------------

function planAnchorOperations(
  content: string,
  operations: readonly LeoEditOperation[],
  strategies: string[],
): { ok: true; ranges: PlannedRange[] } | LeoEditPlanFailure {
  const anchored = operations.filter(
    (operation): operation is Extract<LeoEditOperation, { kind: "anchor" }> =>
      operation.kind === "anchor",
  );
  if (anchored.length === 0) return { ok: true, ranges: [] };

  const lines = content.split("\n");
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }

  const problems: HashlineAnchorProblem[] = [];
  const unparsable: string[] = [];
  const resolve = (reference: string | undefined, label: string): HashlineAnchor | undefined => {
    if (reference === undefined) return undefined;
    const anchor = parseHashlineAnchor(reference);
    if (!anchor) {
      unparsable.push(`${label}: "${reference}" is not a LINE#HASH anchor (e.g. "12#VK").`);
      return undefined;
    }
    if (anchor.line > lines.length) {
      problems.push({ line: anchor.line, reason: "out_of_range" });
    } else if (!anchor.hash) {
      problems.push({ line: anchor.line, reason: "missing_hash" });
    } else if (computeLineHash(anchor.line, lines[anchor.line - 1]!) !== anchor.hash) {
      problems.push({ line: anchor.line, expected: anchor.hash, reason: "mismatch" });
    }
    return anchor;
  };

  const resolved = anchored.map((operation) => ({
    operation,
    pos: resolve(operation.pos, `edits[${operation.index}].pos`),
    end: resolve(operation.end, `edits[${operation.index}].end`),
  }));
  if (unparsable.length > 0) {
    return { ok: false, errorCode: LeoEditErrorCode.INVALID_EDITS, message: unparsable.join("\n") };
  }
  if (problems.length > 0) {
    return {
      ok: false,
      errorCode: LeoEditErrorCode.ANCHOR_MISMATCH,
      message: formatAnchorProblems(dedupeProblems(problems), lines),
    };
  }

  const ranges: PlannedRange[] = [];
  for (const { operation, pos, end } of resolved) {
    strategies[operation.index] = LEO_HASHLINE_ANCHOR_STRATEGY;
    const first = pos?.line;
    const last = end?.line ?? first;
    if (first !== undefined && last !== undefined && last < first) {
      return {
        ok: false,
        errorCode: LeoEditErrorCode.INVALID_EDITS,
        message: `edits[${operation.index}]: end (line ${last}) comes before pos (line ${first}).`,
      };
    }
    ranges.push(anchorRange(operation, first, last, lines, lineStarts, content));
  }
  return { ok: true, ranges };
}

function anchorRange(
  operation: Extract<LeoEditOperation, { kind: "anchor" }>,
  first: number | undefined,
  last: number | undefined,
  lines: readonly string[],
  lineStarts: readonly number[],
  content: string,
): PlannedRange {
  const index = operation.index;
  const body = operation.lines.join("\n");
  const lineCount = lines.length;
  switch (operation.op) {
    case "append": {
      if (content.length === 0) return { start: 0, end: 0, text: body, index };
      const text = content.endsWith("\n") ? `${body}\n` : `\n${body}`;
      return { start: content.length, end: content.length, text, index };
    }
    case "prepend":
      return { start: 0, end: 0, text: content.length === 0 ? body : `${body}\n`, index };
    case "insert_before": {
      const start = lineStarts[first! - 1]!;
      return { start, end: start, text: `${body}\n`, index };
    }
    case "insert_after": {
      if (first! < lineCount) {
        const start = lineStarts[first!]!;
        return { start, end: start, text: `${body}\n`, index };
      }
      return { start: content.length, end: content.length, text: `\n${body}`, index };
    }
    case "delete":
    case "replace": {
      const start = lineStarts[first! - 1]!;
      const endOfLast = lineStarts[last! - 1]! + lines[last! - 1]!.length;
      if (operation.op === "replace" && operation.lines.length > 0) {
        return { start, end: endOfLast, text: body, index };
      }
      // 删除整行：连同一个换行一起删；删到最后一行时吃掉前一个换行。
      if (last! < lineCount) return { start, end: lineStarts[last!]!, text: "", index };
      return { start: first! > 1 ? start - 1 : start, end: endOfLast, text: "", index };
    }
  }
}

function dedupeProblems(problems: HashlineAnchorProblem[]): HashlineAnchorProblem[] {
  const seen = new Map<string, HashlineAnchorProblem>();
  for (const problem of problems) seen.set(`${problem.reason}:${problem.line}`, problem);
  return [...seen.values()];
}

const UTF8_BOM = "﻿";

/** BOM 不参与匹配与行号计算；写回时由调用方原样拼回。 */
export function splitLeoBom(content: string): { bom: string; text: string } {
  return content.startsWith(UTF8_BOM)
    ? { bom: UTF8_BOM, text: content.slice(UTF8_BOM.length) }
    : { bom: "", text: content };
}
