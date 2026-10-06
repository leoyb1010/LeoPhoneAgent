// [leo] 系统提示词里的产品身份是 LOBE,不能再自称 ZCode。
import assert from "node:assert/strict";
import test from "node:test";

import { buildCliPrefixSection } from "../../src/context/sections/cli-prefix.js";
import { buildGeneralPurposeSystemPrompt } from "../../src/subagent/general-purpose.js";

test("agent and built-in subagent prompts identify as LOBE", () => {
  assert.equal(buildCliPrefixSection().content, "You are LOBE, an interactive coding agent");
  const general = buildGeneralPurposeSystemPrompt();
  assert.match(general, /LOBE/);
  assert.doesNotMatch(general, /ZCode/);
});
