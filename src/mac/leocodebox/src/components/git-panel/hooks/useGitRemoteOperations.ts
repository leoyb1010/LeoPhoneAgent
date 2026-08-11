import { useCallback, useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type { GitApiErrorResponse, GitOperationResponse, GitRemoteStatus } from '../types/types';
import { gitGet, gitPost } from '../utils/gitApiClient';
import type { Project } from '../../../types/app';

type Args = {
  selectedProject: Project | null;
  currentBranch: string;
  fetchGitStatus: () => Promise<void>;
  fetchBranches: () => Promise<void>;
  setOperationError: Dispatch<SetStateAction<string | null>>;
};

export function useGitRemoteOperations({
  selectedProject,
  currentBranch,
  fetchGitStatus,
  fetchBranches,
  setOperationError,
}: Args) {
  const [remoteStatus, setRemoteStatus] = useState<GitRemoteStatus | null>(null);
  const [isFetching, setIsFetching] = useState(false);
  const [isPulling, setIsPulling] = useState(false);
  const [isPushing, setIsPushing] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);

  useEffect(() => setRemoteStatus(null), [selectedProject?.projectId]);

  const fetchRemoteStatus = useCallback(async () => {
    if (!selectedProject) return;
    try {
      const data = await gitGet<GitRemoteStatus | GitApiErrorResponse>('remote-status', { project: selectedProject.projectId });
      setRemoteStatus(data.error ? null : data as GitRemoteStatus);
    } catch (error) {
      console.error('Error fetching remote status:', error);
      setRemoteStatus(null);
    }
  }, [selectedProject]);

  const runRemoteOperation = useCallback(async (
    operation: 'fetch' | 'pull' | 'push',
    setPending: Dispatch<SetStateAction<boolean>>,
    includeBranches = false,
  ) => {
    if (!selectedProject) return;
    setPending(true);
    try {
      const data = await gitPost<GitOperationResponse>(operation, { project: selectedProject.projectId });
      if (!data.success) {
        setOperationError(data.error ?? `${operation} failed`);
        return;
      }
      void fetchGitStatus();
      void fetchRemoteStatus();
      if (includeBranches) void fetchBranches();
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : `${operation} failed`);
    } finally {
      setPending(false);
    }
  }, [fetchBranches, fetchGitStatus, fetchRemoteStatus, selectedProject, setOperationError]);

  const handleFetch = useCallback(() => runRemoteOperation('fetch', setIsFetching, true), [runRemoteOperation]);
  const handlePull = useCallback(() => runRemoteOperation('pull', setIsPulling), [runRemoteOperation]);
  const handlePush = useCallback(() => runRemoteOperation('push', setIsPushing), [runRemoteOperation]);
  const handlePublish = useCallback(async () => {
    if (!selectedProject) return;
    setIsPublishing(true);
    try {
      const data = await gitPost<GitOperationResponse>('publish', {
        project: selectedProject.projectId,
        branch: currentBranch,
      });
      if (data.success) {
        void fetchGitStatus();
        void fetchRemoteStatus();
      } else {
        setOperationError(data.error ?? 'Publish failed');
      }
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : 'Publish failed');
    } finally {
      setIsPublishing(false);
    }
  }, [currentBranch, fetchGitStatus, fetchRemoteStatus, selectedProject, setOperationError]);

  return {
    remoteStatus,
    isFetching,
    isPulling,
    isPushing,
    isPublishing,
    fetchRemoteStatus,
    handleFetch,
    handlePull,
    handlePush,
    handlePublish,
  };
}
