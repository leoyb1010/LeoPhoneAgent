// [leo] 系统提示里 Leo 改过的两处：第二大脑的路由提示（有 leo-brain 工具才出现）、
// 「沟通」段不叙述工具调用、跟随用户语言。

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDynamicBehaviorSection,
  buildSessionGuidanceSection,
} from "../../src/context/dynamic-sections.js";

test("brain routing line appears only when the leo-brain search tool is registered", () => {
  assert.equal(buildSessionGuidanceSection(["Read", "Bash"]), null);
  const section = buildSessionGuidanceSection(["Read", "mcp__leo-brain__brain_search"]);
  assert.ok(section);
  assert.match(section.content, /^# Session-specific guidance\n- Leo's second brain/u);
  assert.match(
    section.content,
    /call mcp__leo-brain__brain_search first \(brain_brief is not needed\)/,
  );
  assert.match(section.content, /我的\/之前\/上次\/记得\/笔记\/资料\/大脑/);
  assert.match(
    section.content,
    /never read ~\/\.config\/leo-brain\/\*, ~\/\.leoagent\/key or ~\/\.leoagent\/treasury\.key/,
  );
  // 同一工具表每次渲染相同（prompt cache）。
  assert.equal(
    buildSessionGuidanceSection(["Read", "mcp__leo-brain__brain_search"])?.content,
    section.content,
  );
});

test("communication guidance: no narration before tool calls, mid-turn text is visible, follow the user's language", () => {
  const text = buildDynamicBehaviorSection().content;
  assert.doesNotMatch(text, /Before your first tool call, say in a sentence/);
  assert.doesNotMatch(text, /may not be shown to the user/);
  assert.match(text, /Don't narrate before tool calls/);
  assert.match(text, /reply with only the answer/);
  assert.match(text, /none when the user asked for an answer-only or fixed-format reply/);
  assert.match(text, /Text you write between tool calls is shown to the user/);
  assert.match(text, /Always write in the language of the user's latest message/);
});
