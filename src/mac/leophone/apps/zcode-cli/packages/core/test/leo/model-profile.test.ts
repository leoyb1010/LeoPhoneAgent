// [leo] 按模型档位解析：内置家族默认、用户覆盖优先级、配置校验与合并。

import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeLeoAgentSettings,
  parseLeoAgentSettings,
  resolveLeoModelToolProfile,
} from "../../src/tool/leo/model-profile.js";

const model = (modelId: string, providerId = "p") => ({ modelId, providerId });

test("everything defaults to replace; hashlineFamilies opts GLM / Kimi / MiniMax into hashline", () => {
  const families = ["glm-4.6", "GLM-5", "z-ai/glm-4.5-air", "kimi-k2-0905", "moonshotai/Kimi-K2", "MiniMax-M2"];
  for (const id of [...families, "claude-sonnet-4-5", "gpt-5", "qwen3-coder", "deepseek-chat"]) {
    assert.deepEqual(resolveLeoModelToolProfile(model(id), undefined), { editMode: "replace", readLineFormat: "numbered" }, id);
  }
  for (const id of families) {
    assert.deepEqual(
      resolveLeoModelToolProfile(model(id), { hashlineFamilies: true }),
      { editMode: "hashline", readLineFormat: "hashline" },
      id,
    );
  }
  for (const id of ["claude-sonnet-4-5", "gpt-5", "qwen3-coder", "deepseek-chat"]) {
    assert.equal(resolveLeoModelToolProfile(model(id), { hashlineFamilies: true }).editMode, "replace", id);
  }
  assert.deepEqual(resolveLeoModelToolProfile(undefined, undefined), { editMode: "replace", readLineFormat: "numbered" });
});

test("user model patterns beat the family default; default only applies to unmatched models", () => {
  const settings = {
    hashlineFamilies: true,
    editMode: { default: "hashline" as const, models: { "glm-4.6": "replace" as const } },
    readLineNumbers: { default: true, models: { "qwen*": false } },
  };
  assert.equal(resolveLeoModelToolProfile(model("glm-4.6"), settings).editMode, "replace");
  assert.equal(resolveLeoModelToolProfile(model("glm-5"), settings).editMode, "hashline");
  assert.equal(resolveLeoModelToolProfile(model("gpt-5"), settings).editMode, "hashline");
  // providerId/modelId 形式也能匹配
  assert.equal(
    resolveLeoModelToolProfile(model("qwen3-coder", "dashscope"), { readLineNumbers: { models: { "dashscope/*": false } } }).readLineFormat,
    "plain",
  );
  assert.equal(resolveLeoModelToolProfile(model("gpt-5"), { readLineNumbers: { default: false } }).readLineFormat, "plain");
});

test("parse drops invalid fields with warnings and accepts the shorthand form", () => {
  const { settings, warnings } = parseLeoAgentSettings({
    editMode: "hashline",
    readLineNumbers: { default: "no", models: { "a*": false, "b*": "x" } },
    leanProfile: "yes",
    promptCacheKey: false,
  });
  assert.deepEqual(settings, { editMode: { default: "hashline" }, readLineNumbers: { models: { "a*": false } }, promptCacheKey: false });
  assert.equal(warnings.length, 3);
});

test("merge: later layers win and their model patterns are matched first", () => {
  const merged = mergeLeoAgentSettings(
    { editMode: { default: "replace", models: { "a*": "hashline", "b*": "hashline" } }, leanProfile: true },
    { editMode: { models: { "b*": "replace", "c*": "hashline" } }, leanProfile: false },
  );
  assert.deepEqual(Object.keys(merged.editMode?.models ?? {}), ["b*", "c*", "a*"]);
  assert.equal(merged.editMode?.models?.["b*"], "replace");
  assert.equal(merged.editMode?.default, "replace");
  assert.equal(merged.leanProfile, false);
});
