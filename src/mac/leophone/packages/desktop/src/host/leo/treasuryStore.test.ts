import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// 库路径在模块加载时由 LEOAGENT_HOME 定死:必须先指到临时目录再加载,否则会往用户真实的
// ~/.leoagent/treasury.sqlite 里写 2101 条测试笔记(2026-10-22 实际发生过)。
process.env["LEOAGENT_HOME"] = mkdtempSync(join(tmpdir(), "leo-treasury-test-"));
const { TreasuryStore } = await import("./treasuryStore.js");

test("search finds an old item even when more than 2000 newer items exist (F09)", () => {
  const store = new TreasuryStore();
  try {
    store.save({ kind: "note", title: "很早的一条：量子退火笔记", content: "旧内容" });
    for (let i = 0; i < 2100; i++) store.save({ kind: "note", title: `新笔记 ${i}`, content: "填充" });
    const hits = store.search({ query: "量子退火", limit: 10 });
    assert.equal(hits.length, 1);
    assert.match(hits[0]!.title, /量子退火/);
    // 通配符按字面匹配，不会把 % 当成「任意」。
    assert.equal(store.search({ query: "%", limit: 10 }).length, 0);
  } finally {
    store.close();
  }
});
