import assert from "node:assert/strict";
import test from "node:test";

import { resolveLeoAgentKind } from "../src/leo/leoAgentKind.js";
import {
  formatLeoToolElapsed,
  hasLeoToolElapsed,
  resolveLeoToolChromeState,
} from "../src/leo/leoToolChrome.js";
import { claimLeoTurnEnter, resetLeoTurnEnterForTest } from "../src/leo/leoTurnEnter.js";
import { resolveLeoApprovalRisk } from "../src/leo/leoApprovalRisk.js";

test("[wp-31] tool status bar: running beats, failure family is destructive, everything else success", () => {
  assert.equal(resolveLeoToolChromeState("in_progress", true), "running");
  assert.equal(resolveLeoToolChromeState("failed", false), "failed");
  assert.equal(resolveLeoToolChromeState("stopped", false), "failed");
  assert.equal(resolveLeoToolChromeState("denied", false), "failed");
  assert.equal(resolveLeoToolChromeState("completed", false), "success");
});

test("[wp-31] tool elapsed label", () => {
  assert.equal(formatLeoToolElapsed(420), "0.4s");
  assert.equal(formatLeoToolElapsed(9_960), "9.9s");
  assert.equal(formatLeoToolElapsed(12_400), "12s");
  assert.equal(formatLeoToolElapsed(125_000), "2m05s");
  assert.equal(formatLeoToolElapsed(-1), null);
  // 结束态没有 endedAt 不显示,不拿「现在」冒充结束时间。
  assert.equal(hasLeoToolElapsed(1, undefined, false), false);
  assert.equal(hasLeoToolElapsed(1, undefined, true), true);
  assert.equal(hasLeoToolElapsed(undefined, 5, false), false);
});

test("[wp-31] new-turn entrance plays once, only for the running last turn", () => {
  resetLeoTurnEnterForTest();
  assert.equal(claimLeoTurnEnter("t1", true, false), false);
  assert.equal(claimLeoTurnEnter("t1", false, true), false);
  assert.equal(claimLeoTurnEnter("t1", true, true), true);
  // 虚拟列表重新挂载同一回合不再播。
  assert.equal(claimLeoTurnEnter("t1", true, true), false);
});

test("[wp-31] approval risk bar: medium → attention, high/critical → destructive, low/absent → none", () => {
  assert.equal(resolveLeoApprovalRisk(undefined), undefined);
  assert.equal(resolveLeoApprovalRisk("low"), undefined);
  assert.equal(resolveLeoApprovalRisk("medium"), "medium");
  assert.equal(resolveLeoApprovalRisk("high"), "high");
  assert.equal(resolveLeoApprovalRisk("critical"), "high");
});

test("[wp-31] agent kind defaults to LeoBot and ignores unknown values", () => {
  assert.equal(resolveLeoAgentKind({}), "leobot");
  assert.equal(resolveLeoAgentKind({ agentKind: "gemini" }), "gemini");
  assert.equal(resolveLeoAgentKind({ agentKind: "zcode-cloud" }), "leobot");
});
