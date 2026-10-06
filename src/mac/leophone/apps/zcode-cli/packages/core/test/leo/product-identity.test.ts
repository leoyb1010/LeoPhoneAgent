// [leo] 系统提示词里的产品身份是 LeoBot,不能再自称 ZCode。
import assert from "node:assert/strict";
import test from "node:test";

import { buildCliPrefixSection } from "../../src/context/sections/cli-prefix.js";
import { buildGeneralPurposeSystemPrompt } from "../../src/subagent/general-purpose.js";

test("agent and built-in subagent prompts identify as LeoBot", () => {
  assert.equal(buildCliPrefixSection().content, "You are LeoBot, an interactive coding agent");
  const general = buildGeneralPurposeSystemPrompt();
  assert.match(general, /LeoBot/);
  assert.doesNotMatch(general, /ZCode/);
});
