import { apiClient } from '../../../utils/apiClient';

import { useApiSource } from './useApiSource';

export type BranchResult = { name: string };

interface BranchesResponse {
  localBranches?: string[];
}

export function useBranchesSource(projectId: string | undefined, enabled: boolean) {
  return useApiSource<BranchResult, BranchesResponse>({
    enabled: enabled && !!projectId,
    deps: [projectId],
    fetcher: (signal) => {
      const params = new URLSearchParams({ project: projectId! });
      return apiClient.raw(`/api/git/branches?${params.toString()}`, { signal });
    },
    parse: (data) => (data.localBranches ?? []).map((name) => ({ name })),
  });
}
