import assert from "node:assert/strict";
import test from "node:test";

import { openGroupsForWorkspace, taskGroupAgentChoices, type LeoTaskGroup } from "../src/leo/leoTaskGroups.js";

test("[WP-27] agent choices: LeoBot first, then only available external agents", () => {
  const choices = taskGroupAgentChoices([
    { id: "claude-code", name: "Claude Code", available: true },
    { id: "codex", name: "Codex", available: false },
    { id: "opencode", name: "opencode", available: true },
  ]);
  assert.deepEqual(
    choices.map((choice) => [choice.key, choice.label]),
    [
      ["leo", "LeoBot"],
      ["acp:claude-code", "Claude Code"],
      ["acp:opencode", "opencode"],
    ],
  );
  assert.deepEqual(choices[1]!.agent, { kind: "acp", agentId: "claude-code" });
});

test("[WP-27] home shows only open groups of the current repository", () => {
  const group = (id: string, repoRoot: string, state: "open" | "closed"): LeoTaskGroup => ({
    id,
    title: id,
    prompt: "x",
    repoRoot,
    workspacePath: repoRoot,
    createdAt: 0,
    state,
    members: [],
  });
  const groups = [group("a", "/repo", "open"), group("b", "/repo", "closed"), group("c", "/other", "open"), group("d", "/repo-2", "open")];
  assert.deepEqual(openGroupsForWorkspace(groups, "/repo").map((entry) => entry.id), ["a"]);
  assert.deepEqual(openGroupsForWorkspace(groups, "/repo/packages/app").map((entry) => entry.id), ["a"]);
});
