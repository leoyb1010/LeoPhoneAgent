import type { ModelSelectionView } from "@zcode/services";
import { readComposerRecent, resolveDraftInitialModelSelection } from "@/lib/composerRecent.js";
import type { V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";

/** 新任务草稿初始化；保留 Recent 原意图，由公共 View 解析有效选择。 */
export function initializeNewTaskDraft(
  draft: V4ComposerDraft,
  workspacePath: string,
  workspaceIdentity: string | undefined,
  view: ModelSelectionView,
): V4ComposerDraft {
  const recent = readComposerRecent(workspacePath, workspaceIdentity);
  return {
    ...draft,
    initializeFromNewTask: undefined,
    mode: recent?.mode === "plan" ? "build" : (recent?.mode ?? "build"),
    planEnabled: false,
    modelSelection:
      recent?.modelSelection ??
      resolveDraftInitialModelSelection(view, null).selection ??
      undefined,
  };
}

/**
 * [leo] 新任务草稿若在「还没有任何模型」时初始化，会落下一个空选择；之后用户刚加好第一个模型，
 * 输入框仍停在「选择模型」。只对尚未发出的新任务草稿(root scope)补上 Host 推荐的模型；
 * 已有会话的空选择是历史恢复的确定结果，不在这里改。
 */
export function fillEmptyNewTaskDraftModel(
  draft: V4ComposerDraft,
  view: ModelSelectionView | null,
): V4ComposerDraft {
  if (!view || !draft.mode || draft.modelSelection) return draft;
  const selection = resolveDraftInitialModelSelection(view, null).selection;
  return selection ? { ...draft, modelSelection: selection } : draft;
}
