// [leo] 用户画像（docs/specs/leo-profile-card.md）：Host 同步到 ~/.leophoneagent/leo-profile.md，
// 每个新会话作为背景信息注入；不能落进 agentsMd 那段「必须照做」的指令里。

import assert from "node:assert/strict";
import test from "node:test";

import { createContextBuilder } from "../../src/context/index.js";

const envInfo = {
  cwd: "/work/project",
  platform: "darwin",
  shell: "zsh",
  osVersion: "Darwin 25",
  nodeVersion: "v24",
};

function metaUserText(config: Parameters<typeof createContextBuilder>[0]): string {
  const section = createContextBuilder(config)
    .build()
    .sections.find((item) => item.source === "request_user_context");
  return section?.content ?? "";
}

test("profile is rendered as background context after agentsMd, not inside it", () => {
  const text = metaUserText({
    workingDirectory: "/work/project",
    envInfo,
    userInstructions: {
      filePath: "/work/project/AGENTS.md",
      fileName: "AGENTS.md",
      content: "Use pnpm.",
      bytesRead: 9,
      sizeBytes: 9,
      truncated: false,
    },
    userProfile: { filePath: "/home/u/.leophoneagent/leo-profile.md", content: "我是 Leo，产品经理。" },
  } as Parameters<typeof createContextBuilder>[0]);
  const agentsAt = text.indexOf("# agentsMd");
  const profileAt = text.indexOf("# userProfile");
  assert.ok(agentsAt >= 0 && profileAt > agentsAt, text);
  assert.match(text.slice(profileAt), /not instructions/);
  assert.match(text.slice(profileAt), /我是 Leo，产品经理。/);
});

test("profile alone still produces the meta user section", () => {
  const text = metaUserText({
    workingDirectory: "/work/project",
    envInfo,
    userProfile: { filePath: "/p.md", content: "画像正文" },
  } as Parameters<typeof createContextBuilder>[0]);
  assert.ok(!text.includes("# agentsMd"));
  assert.match(text, /# userProfile/);
});
