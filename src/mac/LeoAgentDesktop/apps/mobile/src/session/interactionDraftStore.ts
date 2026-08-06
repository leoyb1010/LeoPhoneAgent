export interface AskUserDraft {
  answers: Record<string, string>;
  currentIndex: number;
  customInput: string;
  selectedLabels: string[];
  showCustomInput: boolean;
}

export interface PlanReviewDraft {
  feedback: string;
  feedbackOpen: boolean;
  planText: string;
}

const askUserDrafts = new Map<string, AskUserDraft>();
const planReviewDrafts = new Map<string, PlanReviewDraft>();

export function readAskUserDraft(requestId: string): AskUserDraft | null {
  const draft = askUserDrafts.get(requestId);
  return draft ? cloneDraft(draft) : null;
}

export function saveAskUserDraft(requestId: string, draft: AskUserDraft): void {
  if (!requestId) return;
  askUserDrafts.set(requestId, cloneDraft(draft));
}

export function clearAskUserDraft(requestId: string): void {
  askUserDrafts.delete(requestId);
}

export function readPlanReviewDraft(requestId: string): PlanReviewDraft | null {
  const draft = planReviewDrafts.get(requestId);
  return draft ? clonePlanReviewDraft(draft) : null;
}

export function savePlanReviewDraft(requestId: string, draft: PlanReviewDraft): void {
  if (!requestId) return;
  planReviewDrafts.set(requestId, clonePlanReviewDraft(draft));
}

export function clearPlanReviewDraft(requestId: string): void {
  planReviewDrafts.delete(requestId);
}

export function clearAllInteractionDrafts(): void {
  askUserDrafts.clear();
  planReviewDrafts.clear();
}

function cloneDraft(draft: AskUserDraft): AskUserDraft {
  return {
    answers: { ...draft.answers },
    currentIndex: Math.max(0, Math.floor(draft.currentIndex)),
    customInput: draft.customInput,
    selectedLabels: [...draft.selectedLabels],
    showCustomInput: draft.showCustomInput,
  };
}

function clonePlanReviewDraft(draft: PlanReviewDraft): PlanReviewDraft {
  return {
    feedback: draft.feedback,
    feedbackOpen: draft.feedbackOpen,
    planText: draft.planText,
  };
}
