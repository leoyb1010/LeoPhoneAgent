// [leo] 精简档：默认关闭；打开后主会话只有核心工具、最小系统提示词；子会话不受影响。

import assert from "node:assert/strict";
import test from "node:test";

import { createContextBuilder } from "../../src/context/index.js";
import { resolveBuiltInToolAllowlist } from "../../src/runtime/helpers/tool-allowlist.js";
import {
  applyLeoLeanToolAllowlist,
  buildLeoLeanSystemPrompt,
  isLeoLeanProfileActive,
  LEO_LEAN_CORE_TOOLS,
} from "../../src/runtime/leo/lean-profile.js";
import type { AgentRuntimeConfig } from "../../src/runtime/types.js";
import { registerBuiltInTools } from "../../src/tool/handlers/index.js";
import type { ToolEntry } from "../../src/tool/types.js";

const envInfo = {
  cwd: "/work/project",
  platform: "darwin",
  shell: "zsh",
  osVersion: "Darwin 25",
  nodeVersion: "v24",
  isGitRepository: true,
};

function registeredToolNames(config: AgentRuntimeConfig): string[] {
  const names: string[] = [];
  registerBuiltInTools(
    { register: (entry: ToolEntry) => names.push(entry.metadata.name) },
    { allowedTools: resolveBuiltInToolAllowlist(config), includeSkill: true, includeAgent: true },
  );
  return names.sort();
}

test("lean profile is off by default and only applies to main sessions", () => {
  assert.equal(isLeoLeanProfileActive({}), false);
  assert.equal(isLeoLeanProfileActive({ leoAgent: { leanProfile: true } }), true);
  assert.equal(isLeoLeanProfileActive({ leoAgent: { leanProfile: true }, taskType: "subagent_child" }), false);
  assert.equal(isLeoLeanProfileActive({ leoAgent: { leanProfile: true }, taskType: "workflow_child" }), false);
  assert.equal(applyLeoLeanToolAllowlist({}, undefined), undefined);
  assert.deepEqual(applyLeoLeanToolAllowlist({ leoAgent: { leanProfile: true } }, ["Read", "WebFetch", "Bash"]), ["Read", "Bash"]);
});

test("lean main session registers only the core tools", () => {
  const full = registeredToolNames({});
  const lean = registeredToolNames({ leoAgent: { leanProfile: true } });
  assert.ok(full.length > LEO_LEAN_CORE_TOOLS.length);
  assert.deepEqual(lean, [...LEO_LEAN_CORE_TOOLS].sort());
});

test("lean system prompt replaces the long default prompt but keeps environment and AGENTS.md", () => {
  const leanPrompt = buildLeoLeanSystemPrompt({ leoAgent: { leanProfile: true } }, envInfo, undefined);
  assert.ok(leanPrompt?.includes("/work/project"));
  assert.equal(buildLeoLeanSystemPrompt({}, envInfo, undefined), undefined);
  assert.equal(buildLeoLeanSystemPrompt({ leoAgent: { leanProfile: true }, systemPrompt: "mine" }, envInfo, undefined), undefined);

  const userInstructions = {
    content: "Always run pnpm test.",
    sources: [
      {
        scope: "workspace",
        filePath: "/work/project/AGENTS.md",
        fileName: "AGENTS.md",
        content: "Always run pnpm test.",
        bytesRead: 21,
        sizeBytes: 21,
        truncated: false,
      },
    ],
  };
  const base = { workingDirectory: "/work/project", envInfo, userInstructions } as unknown as Parameters<typeof createContextBuilder>[0];
  const defaultBuild = createContextBuilder(base).build();
  const leanBuild = createContextBuilder({ ...base, customSystemPrompt: leanPrompt }).build();
  const systemText = (build: typeof leanBuild) =>
    build.systemMessages.map((message) => JSON.stringify(message.content)).join("\n");
  assert.ok(systemText(leanBuild).includes("Read the relevant code before changing it"));
  assert.ok(leanBuild.totalTokens < defaultBuild.totalTokens / 2, `${leanBuild.totalTokens} vs ${defaultBuild.totalTokens}`);
  const names = leanBuild.sections.map((section) => section.name);
  assert.ok(!names.includes("Context Management"));
  assert.ok(JSON.stringify(leanBuild.metaUserAttachments).includes("Always run pnpm test."));
});
