// [leo] 多段编辑与 hashline 锚点规划的单元测试。

import assert from "node:assert/strict";
import test from "node:test";

import { EditErrorCode, LeoEditErrorCode } from "@zcode/contracts";
import { planLeoMultiEdit, splitLeoBom } from "../../src/tool/leo/edit-plan.js";
import type { LeoEditOperation } from "../../src/tool/leo/edit-request.js";
import {
  computeLineHash,
  formatHashlineContent,
  formatLineTag,
  parseHashlineAnchor,
  stripHashlinePrefixes,
} from "../../src/tool/leo/hashline.js";

const text = (index: number, oldString: string, newString: string, replaceAll = false): LeoEditOperation => ({
  kind: "text",
  index,
  oldString,
  newString,
  replaceAll,
});

const anchor = (
  index: number,
  op: Extract<LeoEditOperation, { kind: "anchor" }>["op"],
  pos: string | undefined,
  lines: string[],
  end?: string,
): LeoEditOperation => ({
  kind: "anchor",
  index,
  op,
  ...(pos === undefined ? {} : { pos }),
  ...(end === undefined ? {} : { end }),
  lines,
});

const FILE = ["import a from 'a';", "", "function one() {", "  return 1;", "}", "", "function two() {", "  return 2;", "}", ""].join("\n");
const tag = (line: number): string => formatLineTag(line, FILE.split("\n")[line - 1]!);

test("multi edit: every old_string is matched against the original content and applied together", () => {
  const result = planLeoMultiEdit({
    content: FILE,
    mode: "replace",
    operations: [text(0, "return 1;", "return 10;"), text(1, "return 2;", "return 20;"), text(2, "import a from 'a';", "import b from 'b';")],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.newContent, /return 10;[\s\S]*return 20;/u);
  assert.ok(result.newContent.startsWith("import b from 'b';"));
  assert.deepEqual(result.strategies, ["exact", "exact", "exact"]);
});

test("multi edit: overlapping, missing and ambiguous edits are rejected without partial application", () => {
  const overlap = planLeoMultiEdit({
    content: FILE,
    mode: "replace",
    operations: [text(0, "function one() {\n  return 1;", "x"), text(1, "return 1;\n}", "y")],
  });
  assert.equal(overlap.ok, false);
  assert.equal(!overlap.ok && overlap.errorCode, LeoEditErrorCode.OVERLAPPING_EDITS);

  const missing = planLeoMultiEdit({
    content: FILE,
    mode: "replace",
    operations: [text(0, "return 1;", "r1"), text(1, "does not exist", "z")],
  });
  assert.equal(!missing.ok && missing.errorCode, EditErrorCode.OLD_STRING_NOT_FOUND);
  assert.match(!missing.ok ? missing.message : "", /edits\[1\]: old_string not found/u);

  const ambiguous = planLeoMultiEdit({
    content: FILE,
    mode: "replace",
    operations: [text(0, "return 1;", "r1"), text(1, "}", ")")],
  });
  assert.equal(!ambiguous.ok && ambiguous.errorCode, EditErrorCode.AMBIGUOUS_REPLACE);
});

test("multi edit: replace_all per edit, and deleting a whole line removes its newline", () => {
  const result = planLeoMultiEdit({
    content: FILE,
    mode: "replace",
    operations: [text(0, "function", "fn", true), text(1, "import a from 'a';", "")],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal((result.newContent.match(/fn /gu) ?? []).length, 2);
  assert.ok(result.newContent.startsWith("\nfn one"));
});

test("multi edit: identical result is reported as NO_CHANGE", () => {
  const result = planLeoMultiEdit({
    content: FILE,
    mode: "replace",
    operations: [text(0, "return 1;", "return 1;"), text(1, "return 2;", "return 2;")],
  });
  assert.equal(!result.ok && result.errorCode, EditErrorCode.NO_CHANGE);
});

test("hashline: tags are two letters from the alphabet, stable, and blank lines mix in the line number", () => {
  const hash = computeLineHash(4, "  return 1;");
  assert.match(hash, /^[ZPMQVRWSNKTXJBYH]{2}$/u);
  assert.equal(computeLineHash(4, "  return 1;"), computeLineHash(99, "  return 1;  "));
  assert.equal(computeLineHash(1, "﻿x"), computeLineHash(1, "x"));
  assert.equal(formatHashlineContent("a\nb", 7), `${formatLineTag(7, "a")}:a\n${formatLineTag(8, "b")}:b`);
  assert.deepEqual(parseHashlineAnchor(" 12 # vk:  return x;"), { line: 12, hash: "VK" });
  assert.deepEqual(parseHashlineAnchor(">>> 3#ZZ"), { line: 3, hash: "ZZ" });
  assert.deepEqual(parseHashlineAnchor("12"), { line: 12 });
  assert.equal(parseHashlineAnchor("line twelve"), undefined);
  assert.equal(stripHashlinePrefixes("1#ZZ:a\n\n2#PM:b"), "a\n\nb");
  assert.equal(stripHashlinePrefixes("1#ZZ:a\nplain"), null);
});

test("hashline: replace range, insert after/before, delete, append and prepend in one call", () => {
  const result = planLeoMultiEdit({
    content: FILE,
    mode: "hashline",
    operations: [
      anchor(0, "replace", tag(3), ["function uno() {", "  return 1 + 0;"], tag(4)),
      anchor(1, "insert_after", tag(5), ["// after one"]),
      anchor(2, "insert_before", tag(7), ["// before two"]),
      anchor(3, "delete", tag(8), []),
      anchor(4, "prepend", undefined, ["// header"]),
      anchor(5, "append", undefined, ["// footer"]),
    ],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(
    result.newContent,
    [
      "// header",
      "import a from 'a';",
      "",
      "function uno() {",
      "  return 1 + 0;",
      "}",
      "// after one",
      "",
      "// before two",
      "function two() {",
      "}",
      "// footer",
      "",
    ].join("\n"),
  );
  assert.deepEqual(new Set(result.strategies), new Set(["hashline_anchor"]));
  assert.ok(result.preview);
  // 预览里的锚点对应新内容的行号与哈希
  const newLines = result.newContent.split("\n");
  for (const line of result.preview!.split("\n")) {
    if (line === "...") continue;
    const parsed = parseHashlineAnchor(line)!;
    assert.equal(computeLineHash(parsed.line, newLines[parsed.line - 1]!), parsed.hash);
  }
});

test("hashline: stale, hashless and out-of-range anchors are all reported with the current anchors", () => {
  const stale = tag(4).endsWith("ZZ") ? "4#PP" : "4#ZZ";
  const result = planLeoMultiEdit({
    content: FILE,
    mode: "hashline",
    operations: [
      anchor(0, "replace", stale, ["  return 42;"]),
      anchor(1, "replace", "8", ["  return 2;"]),
      anchor(2, "insert_after", "99#ZZ", ["x"]),
    ],
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errorCode, LeoEditErrorCode.ANCHOR_MISMATCH);
  assert.match(result.message, /Line 99 does not exist/u);
  assert.match(result.message, />>> 8#[A-Z]{2}: {2}return 2;/u);
  assert.ok(result.message.includes(`>>> ${tag(4)}:  return 1;`));
  assert.match(result.message, /no changes were made/u);
});

test("hashline: text replacements and anchored edits combine; overlap across kinds is rejected", () => {
  const combined = planLeoMultiEdit({
    content: FILE,
    mode: "hashline",
    operations: [anchor(0, "replace", tag(4), ["  return 100;"]), text(1, "return 2;", "return 200;")],
  });
  assert.equal(combined.ok, true);
  assert.deepEqual(combined.ok && combined.strategies, ["hashline_anchor", "exact"]);

  const overlap = planLeoMultiEdit({
    content: FILE,
    mode: "hashline",
    operations: [anchor(0, "replace", tag(3), ["x"], tag(5)), text(1, "return 1;", "r")],
  });
  assert.equal(!overlap.ok && overlap.errorCode, LeoEditErrorCode.OVERLAPPING_EDITS);
});

test("BOM is split off for matching and restored by the caller", () => {
  assert.deepEqual(splitLeoBom("﻿abc"), { bom: "﻿", text: "abc" });
  assert.deepEqual(splitLeoBom("abc"), { bom: "", text: "abc" });
});
