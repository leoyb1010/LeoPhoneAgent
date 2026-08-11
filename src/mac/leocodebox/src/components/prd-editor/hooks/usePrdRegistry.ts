import { useCallback, useEffect, useState } from 'react';

import { apiClient } from '../../../utils/apiClient';
import type { ExistingPrdFile, PrdListResponse } from '../types';

type UsePrdRegistryArgs = {
  // DB primary key of the project (post migration).
  projectId?: string;
};

type UsePrdRegistryResult = {
  existingPrds: ExistingPrdFile[];
  refreshExistingPrds: () => Promise<void>;
};

function getPrdFiles(data: PrdListResponse): ExistingPrdFile[] {
  return data.prdFiles || data.prds || [];
}

export function usePrdRegistry({ projectId }: UsePrdRegistryArgs): UsePrdRegistryResult {
  const [existingPrds, setExistingPrds] = useState<ExistingPrdFile[]>([]);

  const refreshExistingPrds = useCallback(async () => {
    if (!projectId) {
      setExistingPrds([]);
      return;
    }

    try {
      const data = await apiClient.get<PrdListResponse>(
        `/api/taskmaster/prd/${encodeURIComponent(projectId)}`,
      );
      setExistingPrds(getPrdFiles(data));
    } catch (error) {
      console.error('Failed to fetch existing PRDs:', error);
      setExistingPrds([]);
    }
  }, [projectId]);

  useEffect(() => {
    void refreshExistingPrds();
  }, [refreshExistingPrds]);

  return {
    existingPrds,
    refreshExistingPrds,
  };
}
