// ============================================================
// [leo] Edit 工具扩展入参：多段 edits[]、hashline 锚点操作、畸形参数修复
// ============================================================
// 上游 EditInputSchema（edit.ts）只接受单段 old_string/new_string。LeoPhoneAgent 在不改变
// 单段语义的前提下扩展为：
//   1. edits: [{ old_string, new_string, replace_all? }] —— 一次调用改同一文件多处，全部针对
//      原始内容匹配，互不重叠，一起落盘；
//   2. hashline 模式（按模型开启）下 edits[] 还可以是锚点操作
//      { op, pos: "12#VK", end?: "14#QZ", lines }，锚点来自 Read 输出的 `行号#哈希:` 前缀；
//   3. 模型常见的畸形参数（edits 被再编码成 JSON 字符串、单个对象、字段别名、字符串里带裸换行）
//      在 runtime schema 的 preprocess 里修复，修复后的输入才进入 JSON Schema 校验、hook 与权限。
// 运行时 schema 是所有形态的超集；provider 可见的 JSON Schema 按编辑模式分两份。
// 语义校验（必须二选一、锚点合法等）留在 handler，失败以 tool_use_error 回给模型。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const LEO_HASHLINE_EDIT_OPS = [
  "replace",
  "delete",
  "insert_after",
  "insert_before",
  "append",
  "prepend",
] as const;

export type LeoHashlineEditOp = (typeof LEO_HASHLINE_EDIT_OPS)[number];

const TRUE_BOOLEAN_STRINGS = new Set(["true", "1", "yes", "y", "on"]);
const FALSE_BOOLEAN_STRINGS = new Set(["false", "0", "no", "n", "off"]);
const MAX_JSON_REPAIR_DEPTH = 2;

const FILE_PATH_ALIASES = ["path", "filePath", "filepath", "file"] as const;
const OLD_STRING_ALIASES = ["oldText", "old_text", "old_str", "oldString"] as const;
const NEW_STRING_ALIASES = ["newText", "new_text", "new_str", "newString"] as const;
const REPLACE_ALL_ALIASES = ["replaceAll"] as const;
const POS_ALIASES = ["anchor", "start", "line", "loc", "position"] as const;
const END_ALIASES = ["end_pos", "endPos", "to", "until"] as const;
const LINES_ALIASES = ["content", "text", "new_lines", "newLines", "replacement"] as const;

/** 常见的同义操作名（oh-my-pi v1、自然语言化的写法）归一到 LEO_HASHLINE_EDIT_OPS。 */
const OP_ALIASES: Readonly<Record<string, LeoHashlineEditOp>> = {
  replace: "replace",
  replace_line: "replace",
  replace_lines: "replace",
  replace_range: "replace",
  set: "replace",
  delete: "delete",
  remove: "delete",
  delete_lines: "delete",
  insert_after: "insert_after",
  append_at: "insert_after",
  after: "insert_after",
  insert: "insert_after",
  insert_before: "insert_before",
  prepend_at: "insert_before",
  before: "insert_before",
  append: "append",
  append_file: "append",
  eof: "append",
  prepend: "prepend",
  prepend_file: "prepend",
  bof: "prepend",
};

function semanticBoolean(): z.ZodEffects<z.ZodBoolean, boolean, unknown> {
  return z.preprocess((value) => {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (value === 1) return true;
      if (value === 0) return false;
      return value;
    }
    if (typeof value !== "string") return value;
    const normalized = value.trim().toLowerCase();
    if (TRUE_BOOLEAN_STRINGS.has(normalized)) return true;
    if (FALSE_BOOLEAN_STRINGS.has(normalized)) return false;
    return value;
  }, z.boolean());
}

// -----------------------------------------------
// Runtime schema（超集）
// -----------------------------------------------

const LeoEditItemRuntimeSchema = z.object({
  old_string: z.string().optional(),
  new_string: z.string().optional(),
  replace_all: semanticBoolean().optional(),
  op: z.enum(LEO_HASHLINE_EDIT_OPS).optional(),
  pos: z.string().optional(),
  end: z.string().optional(),
  lines: z.union([z.array(z.string()), z.string()]).optional(),
});

export type LeoEditItemInput = z.infer<typeof LeoEditItemRuntimeSchema>;

export const LeoEditInputSchema = z.preprocess(
  repairLeoEditArguments,
  z.object({
    file_path: z.string(),
    old_string: z.string().optional(),
    new_string: z.string().optional(),
    replace_all: semanticBoolean().optional().default(false),
    edits: z.array(LeoEditItemRuntimeSchema).optional(),
  }),
);

export type LeoEditInput = z.infer<typeof LeoEditInputSchema>;

// -----------------------------------------------
// Provider 可见 JSON Schema（按编辑模式）
// -----------------------------------------------

const FILE_PATH_DESCRIPTION = "The absolute path to the file to modify";
const EDITS_REPLACE_DESCRIPTION =
  "Several replacements in the same file, applied together in one call. Every old_string is matched against the ORIGINAL file (not after earlier edits), must be unique (unless replace_all) and must not overlap another edit. Use this instead of the top-level old_string/new_string when changing more than one place.";

const ReplaceModeItemShape = z.object({
  old_string: z
    .string()
    .describe("Exact text to replace, unique in the original file (include enough context)"),
  new_string: z.string().describe("The replacement text"),
  replace_all: z
    .boolean()
    .optional()
    .describe("Replace every occurrence of this old_string (default false)"),
});

const ReplaceModeInputShape = z.object({
  file_path: z.string().describe(FILE_PATH_DESCRIPTION),
  old_string: z
    .string()
    .optional()
    .describe("The text to replace (single edit; omit when using edits)"),
  new_string: z
    .string()
    .optional()
    .describe("The text to replace it with (must be different from old_string)"),
  replace_all: z
    .boolean()
    .optional()
    .default(false)
    .describe("Replace all occurrences of old_string (default false)"),
  edits: z.array(ReplaceModeItemShape).optional().describe(EDITS_REPLACE_DESCRIPTION),
});

const HashlineModeItemShape = z.object({
  op: z
    .enum(LEO_HASHLINE_EDIT_OPS)
    .optional()
    .describe(
      "Anchored operation: replace | delete | insert_after | insert_before | append (end of file) | prepend (start of file). Defaults to replace when pos is given.",
    ),
  pos: z
    .string()
    .optional()
    .describe('Anchor copied from Read output, "LINE#HASH" (e.g. "12#VK"): first line of the range'),
  end: z
    .string()
    .optional()
    .describe('Optional last line of the range (inclusive), "LINE#HASH"; omit for a single line'),
  lines: z
    .array(z.string())
    .optional()
    .describe(
      "New lines WITHOUT the LINE#HASH: prefix, exact indentation. Empty array deletes the range.",
    ),
  old_string: z
    .string()
    .optional()
    .describe("Alternative to anchors: exact text to replace (unique in the original file)"),
  new_string: z.string().optional().describe("Replacement text for old_string"),
  replace_all: z
    .boolean()
    .optional()
    .describe("With old_string: replace every occurrence (default false)"),
});

const HashlineModeInputShape = z.object({
  file_path: z.string().describe(FILE_PATH_DESCRIPTION),
  edits: z
    .array(HashlineModeItemShape)
    .optional()
    .describe(
      "Edits applied together against the file as last read: anchored operations (pos/end/lines) and/or old_string replacements. Ranges must not overlap.",
    ),
  old_string: z
    .string()
    .optional()
    .describe("Single text replacement (alternative to edits): the text to replace"),
  new_string: z.string().optional().describe("The text to replace it with"),
  replace_all: z
    .boolean()
    .optional()
    .default(false)
    .describe("Replace all occurrences of old_string (default false)"),
});

export const LeoEditReplaceModeInputJsonSchema = toToolJsonSchema(ReplaceModeInputShape);
export const LeoEditHashlineModeInputJsonSchema = toToolJsonSchema(HashlineModeInputShape);

// -----------------------------------------------
// 畸形参数修复
// -----------------------------------------------

/**
 * 修复模型常见的 Edit 参数形状问题。纯函数、幂等；无法修复时原样返回，让 schema 报错给模型。
 * - 整个入参或 edits 被编码成 JSON 字符串（含 ```json 围栏、字符串内的裸换行/制表符）；
 * - edits 是单个对象而不是数组；
 * - 字段别名（path / oldText / old_str / newText / anchor / content …）；
 * - 顶层 old_string/new_string 与 edits 同时给出时并入 edits；
 * - hashline 操作名的同义写法（replace_range / append_at / insert …）。
 */
export function repairLeoEditArguments(value: unknown): unknown {
  const input = typeof value === "string" ? parseJsonLenient(value) : value;
  if (!isRecord(input)) return value;

  const out: Record<string, unknown> = { ...input };
  renameFirstAlias(out, FILE_PATH_ALIASES, "file_path");
  renameFirstAlias(out, OLD_STRING_ALIASES, "old_string");
  renameFirstAlias(out, NEW_STRING_ALIASES, "new_string");
  renameFirstAlias(out, REPLACE_ALL_ALIASES, "replace_all");

  let edits = out.edits;
  if (typeof edits === "string") edits = parseJsonLenient(edits);
  if (isRecord(edits)) edits = [edits];
  if (Array.isArray(edits)) {
    out.edits = edits.map((item) =>
      repairEditItem(typeof item === "string" ? parseJsonLenient(item) : item),
    );
  } else if (edits === null) {
    delete out.edits;
  } else if (edits !== undefined) {
    out.edits = edits;
  }

  if (Array.isArray(out.edits) && out.edits.length === 0) {
    delete out.edits;
  }

  if (
    Array.isArray(out.edits) &&
    typeof out.old_string === "string" &&
    typeof out.new_string === "string"
  ) {
    const topLevel: Record<string, unknown> = {
      old_string: out.old_string,
      new_string: out.new_string,
    };
    if (out.replace_all !== undefined) topLevel.replace_all = out.replace_all;
    out.edits = [...out.edits, topLevel];
    delete out.old_string;
    delete out.new_string;
    delete out.replace_all;
  }

  return out;
}

function repairEditItem(item: unknown): unknown {
  if (!isRecord(item)) return item;
  const out: Record<string, unknown> = { ...item };
  renameFirstAlias(out, OLD_STRING_ALIASES, "old_string");
  renameFirstAlias(out, NEW_STRING_ALIASES, "new_string");
  renameFirstAlias(out, REPLACE_ALL_ALIASES, "replace_all");
  renameFirstAlias(out, POS_ALIASES, "pos");
  renameFirstAlias(out, END_ALIASES, "end");
  renameFirstAlias(out, LINES_ALIASES, "lines");
  if (typeof out.op === "string") {
    const op = OP_ALIASES[out.op.trim().toLowerCase().replaceAll("-", "_")];
    if (op) out.op = op;
  }
  // lines 发成一个多行字符串时按行拆开；provider 可见 schema 只声明数组，不拆会被 JSON Schema 拒掉。
  if (typeof out.lines === "string") out.lines = out.lines.replaceAll("\r\n", "\n").split("\n");
  // 行号锚点有时被发成数字（12）而不是 "12#VK"；保留为字符串，交给 handler 给出带正确锚点的错误。
  if (typeof out.pos === "number") out.pos = String(out.pos);
  if (typeof out.end === "number") out.end = String(out.end);
  if (out.end === null) delete out.end;
  if (out.pos === null) delete out.pos;
  return out;
}

function renameFirstAlias(
  record: Record<string, unknown>,
  aliases: readonly string[],
  target: string,
): void {
  if (record[target] !== undefined) return;
  for (const alias of aliases) {
    if (record[alias] === undefined) continue;
    record[target] = record[alias];
    delete record[alias];
    return;
  }
}

function parseJsonLenient(text: string, depth = 0): unknown {
  const trimmed = stripCodeFence(text.trim());
  for (const candidate of [trimmed, escapeControlCharactersInJsonStrings(trimmed)]) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      // 双重编码："[{...}]" 被再包一层引号。
      if (typeof parsed === "string" && depth < MAX_JSON_REPAIR_DEPTH) {
        return parseJsonLenient(parsed, depth + 1);
      }
      return parsed;
    } catch {
      // 继续尝试下一种修复
    }
  }
  return text;
}

function stripCodeFence(text: string): string {
  const match = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/u.exec(text);
  return match ? (match[1] ?? text) : text;
}

/** JSON 字符串字面量里不允许裸控制字符；模型把多行代码塞进字符串时常见。只转义字符串内部。 */
function escapeControlCharactersInJsonStrings(text: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
        result += char;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        result += char;
        continue;
      }
      if (char === '"') {
        inString = false;
        result += char;
        continue;
      }
      if (char === "\n") result += "\\n";
      else if (char === "\r") result += "\\r";
      else if (char === "\t") result += "\\t";
      else result += char;
      continue;
    }
    if (char === '"') inString = true;
    result += char;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// -----------------------------------------------
// 错误码（与上游 EditErrorCode 不冲突）
// -----------------------------------------------

export const LeoEditErrorCode = {
  /** edits[] 形状不合法：缺字段、两种形态混用、空编辑。 */
  INVALID_EDITS: 21,
  /** 同一次调用里的多段编辑区间重叠。 */
  OVERLAPPING_EDITS: 22,
  /** hashline 锚点过期、缺哈希或行号越界。 */
  ANCHOR_MISMATCH: 23,
} as const;

export type LeoEditErrorCode = (typeof LeoEditErrorCode)[keyof typeof LeoEditErrorCode];
