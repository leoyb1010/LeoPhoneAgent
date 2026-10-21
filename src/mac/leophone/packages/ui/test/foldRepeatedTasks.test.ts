import assert from "node:assert/strict";
import test from "node:test";

import { foldRepeatedTaskTitles } from "../src/leo/foldRepeatedTasks.js";

test("consecutive same-title tasks fold behind the newest one", () => {
  const items = [
    { id: "a", title: "只回复两个字母：OK" },
    { id: "b", title: "只回复两个字母：OK" },
    { id: "c", title: "只回复两个字母：OK" },
    { id: "d", title: "指定文本回复测试" },
    { id: "e", title: "只回复两个字母：OK" },
  ];
  const runs = foldRepeatedTaskTitles(items, (item) => item.id, () => false);
  assert.deepEqual(runs.map((run) => [run.item.id, run.hidden.map((item) => item.id)]), [
    ["a", ["b", "c"]],
    ["d", []],
    ["e", []],
  ]);
});

test("active or running tasks are never hidden", () => {
  const items = [
    { id: "a", title: "同名" },
    { id: "b", title: "同名" },
  ];
  const runs = foldRepeatedTaskTitles(items, (item) => item.id, (item) => item.id === "b");
  assert.equal(runs.length, 2);
});
