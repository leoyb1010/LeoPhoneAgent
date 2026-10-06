import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Host 承载 Leo 层（127.0.0.1:38473、手机连接、藏宝阁、订阅代理、自动化）。窗口切到服务器工作台
// 只是带 ?workspaceMode=server 的 reload，不能让 Host 因此不启动或不重建（2026-10-04 回归）。
test("local Host spawn is not gated on the workspace mode the window shows", () => {
  const lifecycle = readFileSync(new URL("./desktopWindowLifecycle.ts", import.meta.url), "utf8");
  const main = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  for (const source of [lifecycle, main]) {
    assert.doesNotMatch(source, /shouldStartLocalHost/);
    assert.doesNotMatch(source, /workspaceMode/);
  }
  assert.match(lifecycle, /const spawnLocalHost = /);
});
