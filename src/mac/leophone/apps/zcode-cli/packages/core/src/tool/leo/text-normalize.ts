// ============================================================
// [leo] Edit 窄归一化匹配层
// ============================================================
// 精确匹配失败后、上游宽松匹配器（line_trimmed / indentation_flexible / block_anchor）之前尝试。
// 只抹平"看不见或排版造成"的差异：Unicode NFC、行尾空白、智能引号、各类破折号、特殊空格。
// 归一化时保留每个归一化字符到原文区间的映射，命中后还原成原文里的真实片段：替换只动命中区间，
// 区间外的字节（包括别处的智能引号、行尾空白）保持不变。
// 思路参考 pi coding agent 的 normalizeForFuzzyMatch（MIT, Copyright (c) 2025 Mario Zechner），
// 这里改为 NFC（不做 NFKC 兼容分解）并按原文位置回写，而不是整行改写成归一化文本。

const SINGLE_QUOTES = new Set(["‘", "’", "‚", "‛"]);
const DOUBLE_QUOTES = new Set(["“", "”", "„", "‟"]);
// U+2010 hyphen … U+2015 horizontal bar, U+2212 minus
const DASHES = new Set(["‐", "‑", "‒", "–", "—", "―", "−"]);
// NBSP, U+2002–U+200A 各类空格, 窄 NBSP, 数学中空格, 全角（表意）空格
const SPACES = new Set([
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  "　",
]);
const ASCII_MAX_CODE_UNIT = 0x7f;

export const LEO_UNICODE_NORMALIZED_STRATEGY = "unicode_normalized";

interface NormalizedView {
  text: string;
  /** 归一化文本第 i 个 code unit 对应的原文起点（含）。 */
  starts: number[];
  /** 归一化文本第 i 个 code unit 对应的原文终点（不含）。 */
  ends: number[];
  /** 最后一行（不以换行结尾的那一段）是否被裁掉了行尾空白。 */
  lastLineTrimmed: boolean;
}

export interface NormalizedCandidate {
  value: string;
  index: number;
}

let graphemeSegmenter: Intl.Segmenter | undefined;

/**
 * 在 content 中查找 search 的窄归一化匹配，返回原文片段与起点。
 * search 与 content 在归一化后完全相同（即不需要归一化）时返回空：那是精确匹配的职责。
 */
export function collectUnicodeNormalizedCandidates(
  content: string,
  search: string,
): NormalizedCandidate[] {
  const needleView = buildNormalizedView(search);
  const needle = needleView.text;
  if (needle.trim().length === 0) return [];

  const haystackView = buildNormalizedView(content);
  const haystack = haystackView.text;
  if (needle === search && haystack === content) return [];

  const candidates: NormalizedCandidate[] = [];
  let position = 0;
  while (position <= haystack.length) {
    const index = haystack.indexOf(needle, position);
    if (index === -1) break;
    const endIndex = index + needle.length;
    position = index + 1;
    // search 最后一行被裁掉了行尾空白时，只接受在行尾结束的命中，避免 "foo " 命中 "foobar"。
    if (needleView.lastLineTrimmed && endIndex < haystack.length && haystack[endIndex] !== "\n") {
      continue;
    }
    // 命中不能从一个被 NFC 合并的字素中间开始或结束，否则回写区间会比命中更宽。
    if (index > 0 && haystackView.starts[index] === haystackView.starts[index - 1]) continue;
    if (endIndex < haystack.length && haystackView.ends[endIndex] === haystackView.ends[endIndex - 1]) {
      continue;
    }
    const originalStart = haystackView.starts[index]!;
    const originalEnd = haystackView.ends[endIndex - 1]!;
    candidates.push({ value: content.slice(originalStart, originalEnd), index: originalStart });
    position = endIndex;
  }
  return candidates;
}

function buildNormalizedView(original: string): NormalizedView {
  const chars: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const lines = original.split("\n");
  let lineStart = 0;
  let lastLineTrimmed = false;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    const isLastLine = lineIndex === lines.length - 1;
    const keptLength = line.trimEnd().length;
    if (isLastLine && keptLength !== line.length) lastLineTrimmed = true;
    appendLine(line.slice(0, keptLength), lineStart, chars, starts, ends);
    if (!isLastLine) {
      chars.push("\n");
      starts.push(lineStart + line.length);
      ends.push(lineStart + line.length + 1);
    }
    lineStart += line.length + 1;
  }

  return { text: chars.join(""), starts, ends, lastLineTrimmed };
}

function appendLine(
  line: string,
  offset: number,
  chars: string[],
  starts: number[],
  ends: number[],
): void {
  if (isAscii(line)) {
    for (let index = 0; index < line.length; index += 1) {
      chars.push(line[index]!);
      starts.push(offset + index);
      ends.push(offset + index + 1);
    }
    return;
  }

  graphemeSegmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const { segment, index } of graphemeSegmenter.segment(line)) {
    const composed = segment.normalize("NFC");
    const segmentStart = offset + index;
    if (composed === segment) {
      for (let unit = 0; unit < segment.length; unit += 1) {
        chars.push(mapCharacter(segment[unit]!));
        starts.push(segmentStart + unit);
        ends.push(segmentStart + unit + 1);
      }
      continue;
    }
    // NFC 改变了这个字素（组合字符合并等）：归一化后的每个 code unit 都映射到整个原字素。
    for (let unit = 0; unit < composed.length; unit += 1) {
      chars.push(mapCharacter(composed[unit]!));
      starts.push(segmentStart);
      ends.push(segmentStart + segment.length);
    }
  }
}

function isAscii(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > ASCII_MAX_CODE_UNIT) return false;
  }
  return true;
}

function mapCharacter(char: string): string {
  if (SINGLE_QUOTES.has(char)) return "'";
  if (DOUBLE_QUOTES.has(char)) return '"';
  if (DASHES.has(char)) return "-";
  if (SPACES.has(char)) return " ";
  return char;
}
