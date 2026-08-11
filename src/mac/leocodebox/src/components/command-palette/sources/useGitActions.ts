import { useCallback } from 'react';

import { apiClient } from '../../../utils/apiClient';

async function postGit(path: string, body: Record<string, unknown>) {
  return apiClient.post(path, body);
}

export function useGitActions(projectId: string | undefined) {
  const fetch = useCallback(() => {
    if (!projectId) return Promise.resolve();
    return postGit('/api/git/fetch', { project: projectId });
  }, [projectId]);

  const pull = useCallback(() => {
    if (!projectId) return Promise.resolve();
    return postGit('/api/git/pull', { project: projectId });
  }, [projectId]);

  const push = useCallback(() => {
    if (!projectId) return Promise.resolve();
    return postGit('/api/git/push', { project: projectId });
  }, [projectId]);

  const checkout = useCallback(
    (branch: string) => {
      if (!projectId) return Promise.resolve();
      return postGit('/api/git/checkout', { project: projectId, branch });
    },
    [projectId],
  );

  return { fetch, pull, push, checkout };
}
