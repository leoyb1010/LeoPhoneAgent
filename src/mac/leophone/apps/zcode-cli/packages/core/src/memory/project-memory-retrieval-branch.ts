import type { Model } from "@zcode/contracts";

export type ProjectMemoryRetrievalBranch = "default-index" | "semantic-recall";

// 上游 3.15.1 默认关。[leo][wp-61] LeoBot 桌面端经设置「智能体 → 记忆」显式打开
// （runtimeConfig.memory.semanticRecall=true，设置默认开），CLI/TUI 不传时保持上游行为。
const PROJECT_MEMORY_SEMANTIC_RECALL_ENABLED = true;

export function resolveProjectMemoryRetrievalBranch(
  semanticRecallEnabled: boolean,
): ProjectMemoryRetrievalBranch {
  return semanticRecallEnabled ? "semantic-recall" : "default-index";
}

export const ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH = resolveProjectMemoryRetrievalBranch(
  PROJECT_MEMORY_SEMANTIC_RECALL_ENABLED,
);

/**
 * [leo][wp-61] 运行时分支：Semantic Recall 的 selector 是同一 turn 模型上的严格 JSON Schema
 * side-call（走用户自己配置的供应商，不连任何官方端点、不用 embedding）。模型不支持 JSON Schema
 * 输出时 selector 根本不会跑，而 semantic 分支又会把 MEMORY.md 索引从系统提示里拿掉 ——
 * 两头落空等于记忆整体失效。所以只在「开关开 + 模型能跑 selector」时才进 semantic 分支，
 * 否则回到 default-index（索引照旧进系统提示）。
 */
export function resolveRuntimeProjectMemoryRetrievalBranch(
  memory: { semanticRecall?: boolean } | undefined,
  model: Pick<Model, "properties"> | undefined,
): ProjectMemoryRetrievalBranch {
  if (memory?.semanticRecall !== true) return "default-index";
  if (model?.properties.supportsJsonSchemaOutput !== true) return "default-index";
  return ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH;
}

// 分支在 context 初始化时按当时的模型定一次，整个 runtime 生命周期内保持一致：
// 系统提示（是否带索引）与 turn 侧（是否 prefetch）必须同一分支，不能各算各的。
const runtimeBranches = new WeakMap<object, ProjectMemoryRetrievalBranch>();

export function rememberProjectMemoryRetrievalBranch(
  runtime: object,
  branch: ProjectMemoryRetrievalBranch,
): ProjectMemoryRetrievalBranch {
  runtimeBranches.set(runtime, branch);
  return branch;
}

export function getProjectMemoryRetrievalBranch(runtime: object): ProjectMemoryRetrievalBranch {
  return runtimeBranches.get(runtime) ?? "default-index";
}
