import assert from "node:assert/strict";
import test from "node:test";

import {
  MODEL_PICKER_MAX_PINNED,
  flattenModelPickerEntries,
  isSameModelValueList,
  rankModelPickerEntries,
  recordRecentModel,
  resolveQuickAccessEntries,
  sanitizeModelValueList,
  togglePinnedModel,
} from "../src/lib/modelPickerQuickAccess.js";

const groups = [
  {
    label: "Anthropic",
    items: [
      { value: "p:anthropic:claude-opus-5", name: "Claude Opus 5", modelId: "claude-opus-5" },
      { value: "p:anthropic:claude-haiku-5", name: "Claude Haiku 5", modelId: "claude-haiku-5" },
    ],
  },
  {
    label: "ChatGPT",
    items: [{ value: "p:chatgpt:gpt-5.5", name: "gpt-5.5", modelId: "gpt-5.5" }],
  },
];

test("togglePinnedModel appends, removes and respects the cap", () => {
  assert.deepEqual(togglePinnedModel([], "a"), { status: "pinned", pinned: ["a"] });
  assert.deepEqual(togglePinnedModel(["a", "b", "c"], "b"), {
    status: "unpinned",
    pinned: ["a", "c"],
  });
  const full = Array.from({ length: MODEL_PICKER_MAX_PINNED }, (_, index) => `m${index}`);
  assert.deepEqual(togglePinnedModel(full, "new"), { status: "full", pinned: full });
  // 已满时仍可取消置顶。
  assert.equal(togglePinnedModel(full, "m3").status, "unpinned");
});

test("recordRecentModel moves to front, dedupes and truncates", () => {
  assert.deepEqual(recordRecentModel([], "a"), ["a"]);
  assert.deepEqual(recordRecentModel(["a", "b", "c"], "c"), ["c", "a", "b"]);
  assert.deepEqual(recordRecentModel(["a", "b", "c"], "d", 3), ["d", "a", "b"]);
  assert.deepEqual(recordRecentModel(["a"], ""), ["a"]);
});

test("sanitizeModelValueList keeps unique non-empty strings within limit", () => {
  assert.deepEqual(sanitizeModelValueList(undefined, 3), []);
  assert.deepEqual(sanitizeModelValueList(["a", "", 1, "a", "b", "c", "d"], 3), ["a", "b", "c"]);
});

test("isSameModelValueList compares order-sensitively", () => {
  assert.equal(isSameModelValueList(["a", "b"], ["a", "b"]), true);
  assert.equal(isSameModelValueList(["a", "b"], ["b", "a"]), false);
});

test("flattenModelPickerEntries keeps menu order, leading items first, unique values", () => {
  const entries = flattenModelPickerEntries(groups, [
    { value: "session", name: "Session model" },
    { value: "p:chatgpt:gpt-5.5", name: "dup" },
  ]);
  assert.deepEqual(
    entries.map((entry) => [entry.item.value, entry.groupLabel]),
    [
      ["session", ""],
      ["p:chatgpt:gpt-5.5", ""],
      ["p:anthropic:claude-opus-5", "Anthropic"],
      ["p:anthropic:claude-haiku-5", "Anthropic"],
    ],
  );
});

test("resolveQuickAccessEntries hides unavailable models and de-duplicates pinned from recent", () => {
  const entries = flattenModelPickerEntries(groups);
  const { pinned, recent } = resolveQuickAccessEntries(
    entries,
    ["p:disabled:model", "p:chatgpt:gpt-5.5"],
    [
      "p:chatgpt:gpt-5.5",
      "p:gone:x",
      "p:anthropic:claude-haiku-5",
      "p:anthropic:claude-opus-5",
      "p:anthropic:claude-haiku-5",
    ],
  );
  assert.deepEqual(
    pinned.map((entry) => entry.item.value),
    ["p:chatgpt:gpt-5.5"],
  );
  assert.deepEqual(
    recent.map((entry) => entry.item.value),
    ["p:anthropic:claude-haiku-5", "p:anthropic:claude-opus-5"],
  );
});

test("resolveQuickAccessEntries caps recents at three", () => {
  const entries = flattenModelPickerEntries([
    {
      label: "X",
      items: ["a", "b", "c", "d"].map((value) => ({ value, name: value })),
    },
  ]);
  const { recent } = resolveQuickAccessEntries(entries, [], ["d", "c", "b", "a"]);
  assert.deepEqual(
    recent.map((entry) => entry.item.value),
    ["d", "c", "b"],
  );
});

test("rankModelPickerEntries searches across providers", () => {
  const entries = flattenModelPickerEntries(groups);
  assert.deepEqual(
    rankModelPickerEntries(entries, "opus").map((entry) => entry.item.value),
    ["p:anthropic:claude-opus-5"],
  );
  // 服务商名称命中排在模型名命中之后。
  assert.deepEqual(
    rankModelPickerEntries(entries, "chat").map((entry) => entry.item.value),
    ["p:chatgpt:gpt-5.5"],
  );
  assert.deepEqual(
    rankModelPickerEntries(entries, "anthropic haiku").map((entry) => entry.item.value),
    ["p:anthropic:claude-haiku-5"],
  );
});
