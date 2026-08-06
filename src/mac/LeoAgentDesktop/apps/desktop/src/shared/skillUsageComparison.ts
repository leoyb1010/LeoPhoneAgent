export const MIN_VERSION_COMPARISON_USE_COUNT = 5;

export interface SkillUsageComparableDocumentVersion {
  skillDocumentHash: string;
  useCount: number;
  averageToolCalls: number;
  averageRepeatedToolCalls: number;
  commandFailureRate: number | null;
}

export interface SkillUsageComparableSummary<TVersion extends SkillUsageComparableDocumentVersion> {
  documentVersions: TVersion[];
  currentDocumentVersion: TVersion | null;
}

export type SkillUsageVersionComparison<
  TVersion extends SkillUsageComparableDocumentVersion = SkillUsageComparableDocumentVersion,
> =
  | {
      status: 'no_current';
    }
  | {
      status: 'no_previous';
      current: TVersion;
    }
  | {
      status: 'current_low_sample';
      current: TVersion;
      previous: TVersion;
    }
  | {
      status: 'previous_low_sample';
      current: TVersion;
      previous: TVersion;
    }
  | SkillUsageComparableVersionComparison<TVersion>;

export interface SkillUsageComparableVersionComparison<
  TVersion extends SkillUsageComparableDocumentVersion = SkillUsageComparableDocumentVersion,
> {
  status: 'comparable';
  current: TVersion;
  previous: TVersion;
  averageToolCallsDelta: number;
  averageRepeatedToolCallsDelta: number;
  commandFailureRateDelta: number | null;
}

export function selectSkillUsageVersionComparison<TVersion extends SkillUsageComparableDocumentVersion>(
  summary: SkillUsageComparableSummary<TVersion>,
): SkillUsageVersionComparison<TVersion> {
  const current = summary.currentDocumentVersion;
  if (!current) return { status: 'no_current' };

  const previous = summary.documentVersions.find((version) =>
    version.skillDocumentHash !== current.skillDocumentHash
  );
  if (!previous) return { status: 'no_previous', current };
  if (current.useCount < MIN_VERSION_COMPARISON_USE_COUNT) {
    return { status: 'current_low_sample', current, previous };
  }
  if (previous.useCount < MIN_VERSION_COMPARISON_USE_COUNT) {
    return { status: 'previous_low_sample', current, previous };
  }

  return {
    status: 'comparable',
    current,
    previous,
    averageToolCallsDelta: current.averageToolCalls - previous.averageToolCalls,
    averageRepeatedToolCallsDelta: current.averageRepeatedToolCalls - previous.averageRepeatedToolCalls,
    commandFailureRateDelta: deltaNullable(current.commandFailureRate, previous.commandFailureRate),
  };
}

function deltaNullable(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  return current - previous;
}
