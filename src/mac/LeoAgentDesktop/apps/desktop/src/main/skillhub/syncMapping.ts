import { mapHubSkillInfoToDesktopInfo, type HubSkillInfoForDesktop } from './infoMapping';

export interface SkillhubBatchDetailResponse {
  items?: HubSkillInfoForDesktop[];
  availableCount?: number;
}

export function buildSkillhubSyncResponse(
  names: string[],
  detailResponses: SkillhubBatchDetailResponse[],
) {
  const mappedBySlug = new Map<string, ReturnType<typeof mapHubSkillInfoToDesktopInfo>>();
  let availableUninstalledCount: number | undefined;

  for (const resp of detailResponses) {
    if (availableUninstalledCount === undefined && typeof resp.availableCount === 'number') {
      availableUninstalledCount = resp.availableCount;
    }
    for (const hub of resp.items ?? []) {
      mappedBySlug.set(hub.slug, mapHubSkillInfoToDesktopInfo(hub));
    }
  }

  const results = names.map((name) => {
    const mapped = mappedBySlug.get(name);
    return mapped ? { exists: true as const, ...mapped } : { name, exists: false as const };
  });

  return {
    success: true as const,
    results,
    ...(typeof availableUninstalledCount === 'number' ? { availableUninstalledCount } : {}),
  };
}
