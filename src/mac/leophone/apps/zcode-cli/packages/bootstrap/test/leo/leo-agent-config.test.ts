// [leo] config.json "leo" 段 + 项目配置 + ZCODE_LEO_AGENT 的合并。

import assert from "node:assert/strict";
import test from "node:test";

import { resolveLeoAgentSettings } from "../../src/app/leo-agent-config.js";

const sources = (userLoaded: boolean, projectPaths: string[]) => ({
  sources: {
    user: { path: "/home/u/.leophoneagent/cli/config.json", loaded: userLoaded },
    project: { path: projectPaths[0], paths: projectPaths, loaded: projectPaths.length > 0 },
  },
}) as unknown as Parameters<typeof resolveLeoAgentSettings>[0]["configResult"];

const files: Record<string, string> = {
  "/home/u/.leophoneagent/cli/config.json": JSON.stringify({
    permission: { mode: "build" },
    leo: { editMode: { models: { "*glm*": "replace" } }, readLineNumbers: false, leanProfile: true },
  }),
  "/repo/zcode.json": JSON.stringify({ leo: { leanProfile: false, editMode: { models: { "gpt-*": "hashline" } } } }),
  "/repo/.zcode/config.json": "{ not json",
};

test("user < project < env; invalid files and values are skipped with warnings", () => {
  const resolved = resolveLeoAgentSettings({
    configResult: sources(true, ["/repo/zcode.json", "/repo/.zcode/config.json"]),
    env: { ZCODE_LEO_AGENT: JSON.stringify({ promptCacheKey: false, editMode: { default: "bogus" } }) },
    readFile: (path) => {
      const content = files[path];
      if (content === undefined) throw new Error("ENOENT");
      return content;
    },
  });
  assert.deepEqual(resolved.settings, {
    editMode: { models: { "gpt-*": "hashline", "*glm*": "replace" } },
    readLineNumbers: { default: false },
    leanProfile: false,
    promptCacheKey: false,
  });
  assert.deepEqual(resolved.warnings, ["ZCODE_LEO_AGENT: leo.editMode.default is invalid"]);
});

test("nothing configured yields empty settings; malformed env JSON is reported", () => {
  const resolved = resolveLeoAgentSettings({
    configResult: sources(false, []),
    env: { ZCODE_LEO_AGENT: "{oops" },
    readFile: () => {
      throw new Error("should not read");
    },
  });
  assert.deepEqual(resolved.settings, {});
  assert.deepEqual(resolved.warnings, ["ZCODE_LEO_AGENT is not valid JSON; ignored"]);
});
