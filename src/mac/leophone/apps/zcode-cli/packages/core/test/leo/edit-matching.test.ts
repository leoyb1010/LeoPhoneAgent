// [leo] 窄归一化匹配层、hashline 前缀剥离、参数修复的单元测试。
// 运行：pnpm --filter @zcode/core test:leo（在 src/mac/leophone 下）

import assert from "node:assert/strict";
import test from "node:test";

import { LeoEditInputSchema, repairLeoEditArguments } from "@zcode/contracts";
import { findEditMatch, normalizeReplacementForMatch } from "../../src/tool/edit-matchers.js";
import { collectUnicodeNormalizedCandidates } from "../../src/tool/leo/text-normalize.js";
import { parseLeoEditRequest } from "../../src/tool/leo/edit-request.js";

test("exact match still wins before any normalization", () => {
  const result = findEditMatch({ content: "a “b” c\na \"b\" c", search: 'a "b" c', replaceAll: false });
  assert.equal(result.status, "matched");
  assert.equal(result.status === "matched" && result.strategy, "exact");
});

test("smart quotes, dashes and special spaces in the file match ASCII old_string", () => {
  const content = "const title = “Hello — world”;\nconst gap = 'a b　c';\n";
  const quotes = findEditMatch({ content, search: 'const title = "Hello - world";', replaceAll: false });
  assert.equal(quotes.status, "matched");
  if (quotes.status !== "matched") return;
  assert.equal(quotes.strategy, "unicode_normalized");
  assert.equal(quotes.actualString, "const title = “Hello — world”;");

  const spaces = findEditMatch({ content, search: "const gap = 'a b c';", replaceAll: false });
  assert.equal(spaces.status === "matched" && spaces.actualString, "const gap = 'a b　c';");
});

test("NFC: decomposed characters in the file match precomposed old_string and map back to original bytes", () => {
  const decomposed = "café = 1;\nother();";
  const candidates = collectUnicodeNormalizedCandidates(decomposed, "café = 1;");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.value, "café = 1;");
  assert.equal(candidates[0]!.index, 0);
});

test("trailing whitespace differences match, but a trimmed last line must end at a line end", () => {
  const content = "function a() {   \n  return 1;\t\n}\nfoobar\n";
  const block = findEditMatch({ content, search: "function a() {\n  return 1;\n}", replaceAll: false });
  assert.equal(block.status === "matched" && block.strategy, "unicode_normalized");
  assert.equal(block.status === "matched" && block.actualString, "function a() {   \n  return 1;\t\n}");
  // "foo " 裁掉行尾空白后不能命中 "foobar" 的前缀
  assert.deepEqual(collectUnicodeNormalizedCandidates(content, "foo "), []);
});

test("hashline prefixes copied into old_string / new_string are stripped as a whole", () => {
  const content = "alpha\n  beta\ngamma\n";
  const search = "2#VK:  beta\n3#ZZ:gamma";
  const result = findEditMatch({ content, search, replaceAll: false });
  assert.equal(result.status, "matched");
  if (result.status !== "matched") return;
  assert.equal(result.strategy, "hashline_prefix_stripped");
  assert.equal(result.actualString, "  beta\ngamma");
  assert.equal(normalizeReplacementForMatch(result.strategy, "2#VK:  BETA\n3#ZZ:gamma"), "  BETA\ngamma");
  // new_string 没有整体带前缀时不动
  assert.equal(normalizeReplacementForMatch(result.strategy, "  BETA\ngamma"), "  BETA\ngamma");
});

test("repair: edits sent as a JSON string (with raw newlines), a single object, or aliases", () => {
  const raw = '[{"old_string": "a\nb", "new_string": "c"}]';
  const repaired = LeoEditInputSchema.parse({ file_path: "/x.ts", edits: raw });
  assert.deepEqual(repaired.edits, [{ old_string: "a\nb", new_string: "c" }]);

  const single = LeoEditInputSchema.parse({ path: "/x.ts", edits: { oldText: "a", newText: "b" } });
  assert.equal(single.file_path, "/x.ts");
  assert.deepEqual(single.edits, [{ old_string: "a", new_string: "b" }]);

  const fenced = repairLeoEditArguments({
    file_path: "/x.ts",
    edits: '```json\n[{"old_string":"x","new_string":"y"}]\n```',
  }) as { edits: unknown };
  assert.deepEqual(fenced.edits, [{ old_string: "x", new_string: "y" }]);

  const doubleEncoded = repairLeoEditArguments({
    file_path: "/x.ts",
    edits: JSON.stringify(JSON.stringify([{ old_string: "x", new_string: "y" }])),
  }) as { edits: unknown };
  assert.deepEqual(doubleEncoded.edits, [{ old_string: "x", new_string: "y" }]);
});

test("repair: top-level old/new plus edits are merged; hashline aliases and string lines normalized", () => {
  const merged = LeoEditInputSchema.parse({
    file_path: "/x.ts",
    old_string: "top",
    new_string: "TOP",
    edits: [{ old_string: "a", new_string: "b" }],
  });
  assert.equal(merged.old_string, undefined);
  assert.equal(merged.edits?.length, 2);

  const anchored = LeoEditInputSchema.parse({
    file_path: "/x.ts",
    edits: [{ op: "replace_range", anchor: "3#VK", end_pos: "4#ZZ", content: "x\r\ny" }],
  });
  assert.deepEqual(anchored.edits, [{ op: "replace", pos: "3#VK", end: "4#ZZ", lines: ["x", "y"] }]);
});

test("request: single-item edits behave like the upstream single edit; invalid shapes are rejected", () => {
  const single = parseLeoEditRequest({ file_path: "/x.ts", edits: [{ old_string: "", new_string: "new file" }] });
  assert.equal(single.ok && single.single?.old_string, "");

  const mixed = parseLeoEditRequest({
    file_path: "/x.ts",
    edits: [
      { old_string: "a", new_string: "b", pos: "1#ZZ" },
      { op: "insert_after", lines: ["x"] },
    ],
  });
  assert.equal(mixed.ok, false);
  assert.match(mixed.ok ? "" : mixed.message, /edits\[0\] mixes/u);
  assert.match(mixed.ok ? "" : mixed.message, /edits\[1\] \(insert_after\) needs pos/u);

  const missing = parseLeoEditRequest({ file_path: "/x.ts" });
  assert.equal(missing.ok, false);
});
