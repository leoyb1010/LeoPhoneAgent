import assert from "node:assert/strict";
import test from "node:test";

import type { ModelSelectionView } from "@zcode/services";
import { fillEmptyNewTaskDraftModel } from "../src/v4/composer/newTaskDraft.js";

const preferred = { providerId: "p1", modelId: "m1", options: { reasoningLevel: "high" } };
const view = {
  revision: 2,
  providers: [
    {
      providerId: "p1",
      providerName: "新供应商",
      config: {},
      models: [
        { modelId: "m1", config: { optionSpecs: { reasoningLevel: { values: ["low", "high"] } } } },
      ],
    },
  ],
  preferredSelection: preferred,
} as unknown as ModelSelectionView;

test("新任务草稿在加好第一个模型后自动选上 Host 推荐的模型", () => {
  const filled = fillEmptyNewTaskDraftModel({ text: "", mode: "build", updatedAt: 0 }, view);
  assert.deepEqual(filled.modelSelection, preferred);
});

test("已有选择、尚未初始化或还没有 View 时保持原样", () => {
  const chosen = {
    text: "",
    mode: "build" as const,
    updatedAt: 0,
    modelSelection: { providerId: "p9", modelId: "x" },
  };
  assert.equal(fillEmptyNewTaskDraftModel(chosen, view), chosen);
  const uninit = { text: "", updatedAt: 0 };
  assert.equal(fillEmptyNewTaskDraftModel(uninit, view), uninit);
  const empty = { text: "", mode: "build" as const, updatedAt: 0 };
  assert.equal(fillEmptyNewTaskDraftModel(empty, null), empty);
  const noModels = {
    ...view,
    providers: [],
    preferredSelection: undefined,
  } as unknown as ModelSelectionView;
  assert.equal(fillEmptyNewTaskDraftModel(empty, noModels), empty);
});
