export interface SkillUsagePanelState {
  entryId: string | null;
  loading: boolean;
  error: string | null;
  summary: SkillUsageSummary | null;
}

export interface SkillUsageSummaryRequest {
  entryId: string;
  name: string;
  mdPath?: string;
  refreshNonce: number;
  dayKey: string;
}

export function buildUsageSummaryRequest(params: {
  entryId: string | null;
  name: string | null;
  mdPath: string | null;
  refreshNonce: number;
  dayKey: string;
}): SkillUsageSummaryRequest | null {
  if (!params.entryId || !params.name) return null;
  return {
    entryId: params.entryId,
    name: params.name,
    mdPath: params.mdPath ?? undefined,
    refreshNonce: params.refreshNonce,
    dayKey: params.dayKey,
  };
}

export function beginUsageSummaryRequest(
  previous: SkillUsagePanelState,
  entryId: string,
): SkillUsagePanelState {
  if (previous.entryId === entryId && previous.summary) {
    return {
      ...previous,
      loading: true,
      error: null,
    };
  }
  return {
    entryId,
    loading: true,
    error: null,
    summary: null,
  };
}

export function settleUsageSummarySuccess(
  previous: SkillUsagePanelState,
  entryId: string,
  result: { refreshing: boolean; summary: SkillUsageSummary },
): SkillUsagePanelState {
  const keepPreviousSummary =
    previous.entryId === entryId &&
    previous.summary !== null &&
    result.refreshing &&
    result.summary.totalUseCount === 0;
  return {
    entryId,
    loading: result.refreshing,
    error: null,
    summary: keepPreviousSummary ? previous.summary : result.summary,
  };
}

export function settleUsageSummaryFailure(
  previous: SkillUsagePanelState,
  entryId: string,
  error: string,
): SkillUsagePanelState {
  return {
    entryId,
    loading: false,
    error,
    summary: previous.entryId === entryId ? previous.summary : null,
  };
}
