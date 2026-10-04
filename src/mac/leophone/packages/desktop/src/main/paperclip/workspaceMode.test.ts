import assert from "node:assert/strict";
import { test } from "node:test";
import { requestsLocalRecovery } from "./workspaceMode.js";

test("server workspace cannot implicitly start the local execution Host", () => {
  for (const url of [
    "file:///app/index.html",
    "file:///app/index.html?restoreSession=true",
    "file:///app/index.html?workspaceMode=server",
    "bad-url",
  ])
    assert.equal(requestsLocalRecovery(url), false);
  assert.equal(requestsLocalRecovery("file:///app/index.html?workspaceMode=local-recovery"), true);
});
