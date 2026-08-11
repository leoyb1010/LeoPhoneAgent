import { useCallback, useState } from 'react';

import { apiClient } from '../../../utils/apiClient';
import type { GitOperationResponse } from '../types/types';

type UseRevertLocalCommitOptions = {
  // DB primary key for the project; forwarded to the git API via the
  // `project` body param.
  projectId: string | null;
  onSuccess?: () => void;
};

export function useRevertLocalCommit({ projectId, onSuccess }: UseRevertLocalCommitOptions) {
  const [isRevertingLocalCommit, setIsRevertingLocalCommit] = useState(false);

  const revertLatestLocalCommit = useCallback(async () => {
    if (!projectId) {
      return;
    }

    setIsRevertingLocalCommit(true);
    try {
      const data = await apiClient.post<GitOperationResponse>(
        '/api/git/revert-local-commit',
        { project: projectId },
      );

      if (!data.success) {
        console.error('Revert local commit failed:', data.error || data.details || 'Unknown error');
        return;
      }

      onSuccess?.();
    } catch (error) {
      console.error('Error reverting local commit:', error);
    } finally {
      setIsRevertingLocalCommit(false);
    }
  }, [onSuccess, projectId]);

  return {
    isRevertingLocalCommit,
    revertLatestLocalCommit,
  };
}
