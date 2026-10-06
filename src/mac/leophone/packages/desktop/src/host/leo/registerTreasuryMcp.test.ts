import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import test from "node:test";

import { resolveScriptPath } from "./registerTreasuryMcp.js";

const desktop = resolve(fileURLToPath(import.meta.url), "../../../..");

test("treasury MCP script is found from both the source tree and the bundled out/host", () => {
  const expected = resolve(desktop, "leo/treasury-mcp.mjs");
  assert.ok(existsSync(expected));
  assert.equal(resolveScriptPath(resolve(desktop, "src/host/leo")), expected);
  // tsup 把 host 打成 out/host/index.js:以前从这里解析到 packages/leo/…,藏宝阁 MCP 在开发态从不登记。
  assert.equal(resolveScriptPath(resolve(desktop, "out/host")), expected);
});
