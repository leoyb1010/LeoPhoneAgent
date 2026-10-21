import assert from "node:assert/strict";
import { test } from "node:test";

import { TreasuryStore } from "./treasuryStore.js";

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
