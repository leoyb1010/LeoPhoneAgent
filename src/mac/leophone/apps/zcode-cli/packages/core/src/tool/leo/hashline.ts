// ============================================================
// [leo] hashline：带内容哈希的行地址
// ============================================================
// Read 在 hashline 模式下把每行显示为 `行号#哈希:内容`（例如 `12#VK:  return x;`），Edit 用
// "12#VK" 这样的锚点指定行。锚点同时是地址与新鲜度校验：文件在上次 Read 之后变了，哈希对不上，
// 编辑在落盘前就被拒绝，并把正确的锚点回给模型。
// 格式来自 Can Bölük《The Harness Problem》与 oh-my-pi 的 hashline v1（MIT, Copyright (c) 2025 Mario Zechner, (c) 2025-2026 Can Bölük）：
// 两位哈希、取自 16 个易辨认字母的字母表（与数字区分开），对不含字母数字的行混入行号降低碰撞。
// 哈希函数换成无依赖的 FNV-1a + murmur3 fmix32（原实现用 Bun 的 xxHash32）。

const HASH_ALPHABET = "ZPMQVRWSNKTXJBYH";
const HASH_CHARACTER_CLASS = `[${HASH_ALPHABET}]`;
const SIGNIFICANT_CHARACTER = /[\p{L}\p{N}]/u;
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const BYTE_MASK = 0xff;
const NIBBLE_BITS = 4;
const NIBBLE_MASK = 0x0f;
const MISMATCH_CONTEXT_LINES = 2;
const BYTE_ORDER_MARK = 0xfeff;

/** Read 输出里一行的前缀：`12#VK:`。 */
const DISPLAY_PREFIX = new RegExp(`^(\\d+)#(${HASH_CHARACTER_CLASS}{2}):`, "u");
/** 模型写回来的锚点：容忍空白、`>>>` 标记、带着 `:内容` 的整行。 */
const ANCHOR_REFERENCE = new RegExp(
  `^\\s*(?:>>>\\s*)?(\\d+)\\s*(?:#\\s*(${HASH_CHARACTER_CLASS}{2}))?(?:\\s*[:|].*)?\\s*$`,
  "su",
);

export interface HashlineAnchor {
  line: number;
  hash?: string;
}

export function computeLineHash(lineNumber: number, line: string): string {
  let text = line.replaceAll("\r", "").trimEnd();
  if (text.charCodeAt(0) === BYTE_ORDER_MARK) text = text.slice(1);
  const seed = SIGNIFICANT_CHARACTER.test(text) ? 0 : lineNumber;
  const byte = hashString(text, seed) & BYTE_MASK;
  return `${HASH_ALPHABET[byte >>> NIBBLE_BITS]}${HASH_ALPHABET[byte & NIBBLE_MASK]}`;
}

export function formatLineTag(lineNumber: number, line: string): string {
  return `${lineNumber}#${computeLineHash(lineNumber, line)}`;
}

/** Read 的 hashline 显示：与 cat -n 模式一样按 \r?\n 分行，行号从 startLine 起。 */
export function formatHashlineContent(content: string, startLine: number): string {
  return content
    .split(/\r?\n/u)
    .map((line, index) => `${formatLineTag(index + startLine, line)}:${line}`)
    .join("\n");
}

export function parseHashlineAnchor(reference: string): HashlineAnchor | undefined {
  // 哈希字母表全大写；模型偶尔写成小写，大写化只影响匹配，不影响取出的行号。
  const match = ANCHOR_REFERENCE.exec(reference.toUpperCase());
  if (!match) return undefined;
  const line = Number.parseInt(match[1]!, 10);
  if (!Number.isSafeInteger(line) || line < 1) return undefined;
  return match[2] ? { line, hash: match[2] } : { line };
}

/**
 * 模型把 Read 的 `12#VK:` 前缀连同内容一起抄进了 old_string / new_string / lines：
 * 只有当每一个非空行都带合法前缀时才剥离（空行允许没有前缀），否则原样返回 null。
 */
export function stripHashlinePrefixes(text: string): string | null {
  const lines = text.split("\n");
  let prefixed = 0;
  const stripped: string[] = [];
  for (const line of lines) {
    const match = DISPLAY_PREFIX.exec(line);
    if (match) {
      prefixed += 1;
      stripped.push(line.slice(match[0].length));
      continue;
    }
    if (line.trim() === "") {
      stripped.push(line);
      continue;
    }
    return null;
  }
  return prefixed > 0 ? stripped.join("\n") : null;
}

export function stripHashlinePrefixesFromLines(lines: readonly string[]): string[] {
  const stripped = stripHashlinePrefixes(lines.join("\n"));
  return stripped === null ? [...lines] : stripped.split("\n");
}

export interface HashlineAnchorProblem {
  line: number;
  expected?: string;
  reason: "mismatch" | "missing_hash" | "out_of_range";
}

/**
 * 锚点问题一次性全部报告：给出每个问题行 ±2 行的当前 `行号#哈希:内容`，`>>>` 标出问题行，
 * 模型可以直接照抄正确锚点，不必重新 Read 整个文件。
 */
export function formatAnchorProblems(
  problems: readonly HashlineAnchorProblem[],
  fileLines: readonly string[],
): string {
  const outOfRange = problems.filter((problem) => problem.reason === "out_of_range");
  const inRange = problems.filter((problem) => problem.reason !== "out_of_range");
  const header: string[] = [];
  if (outOfRange.length > 0) {
    header.push(
      `Line ${outOfRange.map((problem) => problem.line).join(", ")} does not exist (file has ${fileLines.length} lines).`,
    );
  }
  if (inRange.length > 0) {
    header.push(
      `${inRange.length} anchor${inRange.length > 1 ? "s are" : " is"} stale or incomplete (the file changed since your last Read, or the LINE#HASH was mistyped). Use the current anchors below (>>> marks the lines you referenced) and retry; no changes were made.`,
    );
  }
  const marked = new Set(inRange.map((problem) => problem.line));
  const shown = new Set<number>();
  for (const problem of inRange) {
    const low = Math.max(1, problem.line - MISMATCH_CONTEXT_LINES);
    const high = Math.min(fileLines.length, problem.line + MISMATCH_CONTEXT_LINES);
    for (let line = low; line <= high; line += 1) shown.add(line);
  }
  const body: string[] = [];
  let previous = -1;
  for (const line of [...shown].sort((left, right) => left - right)) {
    if (previous !== -1 && line > previous + 1) body.push("    ...");
    previous = line;
    const text = fileLines[line - 1] ?? "";
    body.push(`${marked.has(line) ? ">>> " : "    "}${formatLineTag(line, text)}:${text}`);
  }
  return [...header, ...(body.length > 0 ? ["", ...body] : [])].join("\n");
}

function hashString(text: string, seed: number): number {
  let hash = (FNV_OFFSET_BASIS ^ seed) >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  // murmur3 fmix32：让低 8 位依赖全部输入位。
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}
