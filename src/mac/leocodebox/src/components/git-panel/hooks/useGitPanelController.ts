import { useCallback, useEffect, useRef, useState } from 'react';

import { DEFAULT_BRANCH, RECENT_COMMITS_LIMIT } from '../constants/constants';
import type {
  GitBranchesResponse,
  GitCommitSummary,
  GitCommitsResponse,
  GitDiffMap,
  GitDiffResponse,
  GitFileWithDiffResponse,
  GitGenerateMessageResponse,
  GitOperationResponse,
  GitPanelController,
  GitStatusResponse,
  UseGitPanelControllerOptions,
} from '../types/types';
import { gitGet, gitPost, isAbortError } from '../utils/gitApiClient';
import { getAllChangedFiles } from '../utils/gitPanelUtils';

import { useGitRemoteOperations } from './useGitRemoteOperations';
import { useSelectedProvider } from './useSelectedProvider';

export function useGitPanelController({
  selectedProject,
  activeView,
  onFileOpen,
}: UseGitPanelControllerOptions): GitPanelController {
  const [gitStatus, setGitStatus] = useState<GitStatusResponse | null>(null);
  const [gitDiff, setGitDiff] = useState<GitDiffMap>({});
  const [isLoading, setIsLoading] = useState(false);
  const [currentBranch, setCurrentBranch] = useState('');
  const [branches, setBranches] = useState<string[]>([]);
  const [recentCommits, setRecentCommits] = useState<GitCommitSummary[]>([]);
  const [commitDiffs, setCommitDiffs] = useState<GitDiffMap>({});
  const [localBranches, setLocalBranches] = useState<string[]>([]);
  const [remoteBranches, setRemoteBranches] = useState<string[]>([]);
  const [isCreatingBranch, setIsCreatingBranch] = useState(false);
  const [isCreatingInitialCommit, setIsCreatingInitialCommit] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);

  const clearOperationError = useCallback(() => setOperationError(null), []);
  // Tracks the DB projectId so async requests can detect stale responses when
  // the user switches projects mid-flight.
  const selectedProjectIdRef = useRef<string | null>(selectedProject?.projectId ?? null);

  useEffect(() => {
    selectedProjectIdRef.current = selectedProject?.projectId ?? null;
  }, [selectedProject]);

  const provider = useSelectedProvider();

  const fetchFileDiff = useCallback(
    async (filePath: string, signal?: AbortSignal) => {
      if (!selectedProject) {
        return;
      }

      // Git endpoints receive the DB projectId via the `project` query param.
      const projectId = selectedProject.projectId;

      try {
        const data = await gitGet<GitDiffResponse>('diff', { project: projectId, file: filePath }, signal);

        if (
          signal?.aborted ||
          selectedProjectIdRef.current !== projectId
        ) {
          return;
        }

        if (!data.error && data.diff) {
          setGitDiff((previous) => ({
            ...previous,
            [filePath]: data.diff as string,
          }));
        }
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
          return;
        }

        console.error('Error fetching file diff:', error);
      }
    },
    [selectedProject],
  );

  const fetchGitStatus = useCallback(async (signal?: AbortSignal) => {
    if (!selectedProject) {
      return;
    }

    // `project` query param carries the DB projectId everywhere now.
    const projectId = selectedProject.projectId;

    setIsLoading(true);
    try {
      const data = await gitGet<GitStatusResponse>('status', { project: projectId }, signal);

      if (
        signal?.aborted ||
        selectedProjectIdRef.current !== projectId
      ) {
        return;
      }

      if (data.error) {
        console.error('Git status error:', data.error);
        setGitStatus({ error: data.error, details: data.details });
        setCurrentBranch('');
        return;
      }

      setGitStatus(data);
      setCurrentBranch(data.branch || DEFAULT_BRANCH);

      const changedFiles = getAllChangedFiles(data);
      changedFiles.forEach((filePath) => {
        void fetchFileDiff(filePath, signal);
      });
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        return;
      }

      if (
        selectedProjectIdRef.current !== projectId
      ) {
        return;
      }

      console.error('Error fetching git status:', error);
      setGitStatus({ error: 'Git operation failed', details: String(error) });
      setCurrentBranch('');
    } finally {
      setIsLoading(false);
    }
  }, [fetchFileDiff, selectedProject]);

  const fetchBranches = useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    try {
      const data = await gitGet<GitBranchesResponse>('branches', { project: selectedProject.projectId });

      if (!data.error && data.branches) {
        setBranches(data.branches);
        setLocalBranches(data.localBranches ?? data.branches);
        setRemoteBranches(data.remoteBranches ?? []);
        return;
      }

      setBranches([]);
      setLocalBranches([]);
      setRemoteBranches([]);
    } catch (error) {
      console.error('Error fetching branches:', error);
      setBranches([]);
      setLocalBranches([]);
      setRemoteBranches([]);
    }
  }, [selectedProject]);


  const {
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
  } = useGitRemoteOperations({
    selectedProject,
    currentBranch,
    fetchGitStatus,
    fetchBranches,
    setOperationError,
  });

  const switchBranch = useCallback(
    async (branchName: string) => {
      if (!selectedProject) {
        return false;
      }

      try {
        const data = await gitPost<GitOperationResponse>('checkout', {
            project: selectedProject.projectId,
            branch: branchName,
          });
        if (!data.success) {
          console.error('Failed to switch branch:', data.error);
          return false;
        }

        setCurrentBranch(branchName);
        void fetchGitStatus();
        return true;
      } catch (error) {
        console.error('Error switching branch:', error);
        return false;
      }
    },
    [fetchGitStatus, selectedProject],
  );

  const createBranch = useCallback(
    async (branchName: string) => {
      const trimmedBranchName = branchName.trim();
      if (!selectedProject || !trimmedBranchName) {
        return false;
      }

      setIsCreatingBranch(true);
      try {
        const data = await gitPost<GitOperationResponse>('create-branch', {
            project: selectedProject.projectId,
            branch: trimmedBranchName,
          });
        if (!data.success) {
          console.error('Failed to create branch:', data.error);
          return false;
        }

        setCurrentBranch(trimmedBranchName);
        void fetchBranches();
        void fetchGitStatus();
        return true;
      } catch (error) {
        console.error('Error creating branch:', error);
        return false;
      } finally {
        setIsCreatingBranch(false);
      }
    },
    [fetchBranches, fetchGitStatus, selectedProject],
  );

  const deleteBranch = useCallback(
    async (branchName: string) => {
      if (!selectedProject) return false;

      try {
        const data = await gitPost<GitOperationResponse>('delete-branch', { project: selectedProject.projectId, branch: branchName });
        if (!data.success) {
          setOperationError(data.error ?? 'Delete branch failed');
          return false;
        }

        void fetchBranches();
        return true;
      } catch (error) {
        setOperationError(error instanceof Error ? error.message : 'Delete branch failed');
        return false;
      }
    },
    [fetchBranches, selectedProject],
  );


  const discardChanges = useCallback(
    async (filePath: string) => {
      if (!selectedProject) {
        return;
      }

      try {
        const data = await gitPost<GitOperationResponse>('discard', {
            project: selectedProject.projectId,
            file: filePath,
          });
        if (data.success) {
          void fetchGitStatus();
          return;
        }

        console.error('Discard failed:', data.error);
      } catch (error) {
        console.error('Error discarding changes:', error);
      }
    },
    [fetchGitStatus, selectedProject],
  );

  const deleteUntrackedFile = useCallback(
    async (filePath: string) => {
      if (!selectedProject) {
        return;
      }

      try {
        const data = await gitPost<GitOperationResponse>('delete-untracked', {
            project: selectedProject.projectId,
            file: filePath,
          });
        if (data.success) {
          void fetchGitStatus();
          return;
        }

        console.error('Delete failed:', data.error);
      } catch (error) {
        console.error('Error deleting untracked file:', error);
      }
    },
    [fetchGitStatus, selectedProject],
  );

  const stageFiles = useCallback(
    async (files: string[]) => {
      if (!selectedProject || files.length === 0) {
        return false;
      }

      try {
        const data = await gitPost<GitOperationResponse>('stage', {
            project: selectedProject.projectId,
            files,
          });
        if (!data.success) {
          setOperationError(data.error ?? 'Stage failed');
          return false;
        }

        // Refresh so the Staged section re-syncs from the real index.
        await fetchGitStatus();
        return true;
      } catch (error) {
        setOperationError(error instanceof Error ? error.message : 'Stage failed');
        return false;
      }
    },
    [fetchGitStatus, selectedProject],
  );

  const unstageFiles = useCallback(
    async (files: string[]) => {
      if (!selectedProject || files.length === 0) {
        return false;
      }

      try {
        const data = await gitPost<GitOperationResponse>('unstage', {
            project: selectedProject.projectId,
            files,
          });
        if (!data.success) {
          setOperationError(data.error ?? 'Unstage failed');
          return false;
        }

        await fetchGitStatus();
        return true;
      } catch (error) {
        setOperationError(error instanceof Error ? error.message : 'Unstage failed');
        return false;
      }
    },
    [fetchGitStatus, selectedProject],
  );

  const fetchRecentCommits = useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    try {
      const data = await gitGet<GitCommitsResponse>('commits', {
        project: selectedProject.projectId,
        limit: RECENT_COMMITS_LIMIT,
      });

      if (!data.error && data.commits) {
        setRecentCommits(data.commits);
      }
    } catch (error) {
      console.error('Error fetching commits:', error);
    }
  }, [selectedProject]);

  const fetchCommitDiff = useCallback(
    async (commitHash: string) => {
      if (!selectedProject) {
        return;
      }

      try {
        const data = await gitGet<GitDiffResponse>('commit-diff', {
          project: selectedProject.projectId,
          commit: commitHash,
        });

        if (!data.error && data.diff) {
          setCommitDiffs((previous) => ({
            ...previous,
            [commitHash]: data.diff as string,
          }));
        }
      } catch (error) {
        console.error('Error fetching commit diff:', error);
      }
    },
    [selectedProject],
  );

  const generateCommitMessage = useCallback(
    async (files: string[]) => {
      if (!selectedProject || files.length === 0) {
        return null;
      }

      try {
        const data = await gitPost<GitGenerateMessageResponse>('generate-commit-message', {
            project: selectedProject.projectId,
            files,
            provider,
          });
        if (data.message) {
          return data.message;
        }

        console.error('Failed to generate commit message:', data.error);
        return null;
      } catch (error) {
        console.error('Error generating commit message:', error);
        return null;
      }
    },
    [provider, selectedProject],
  );

  const commitChanges = useCallback(
    async (message: string, files: string[]) => {
      if (!selectedProject || !message.trim() || files.length === 0) {
        return false;
      }

      try {
        const data = await gitPost<GitOperationResponse>('commit', {
            project: selectedProject.projectId,
            message,
            files,
          });
        if (data.success) {
          void fetchGitStatus();
          void fetchRemoteStatus();
          return true;
        }

        console.error('Commit failed:', data.error);
        return false;
      } catch (error) {
        console.error('Error committing changes:', error);
        return false;
      }
    },
    [fetchGitStatus, fetchRemoteStatus, selectedProject],
  );

  const createInitialCommit = useCallback(async () => {
    if (!selectedProject) {
      throw new Error('No project selected');
    }

    setIsCreatingInitialCommit(true);
    try {
      const data = await gitPost<GitOperationResponse>('initial-commit', {
          project: selectedProject.projectId,
        });
      if (data.success) {
        void fetchGitStatus();
        void fetchRemoteStatus();
        return true;
      }

      throw new Error(data.error || 'Failed to create initial commit');
    } catch (error) {
      console.error('Error creating initial commit:', error);
      throw error;
    } finally {
      setIsCreatingInitialCommit(false);
    }
  }, [fetchGitStatus, fetchRemoteStatus, selectedProject]);

  const openFile = useCallback(
    async (filePath: string) => {
      if (!onFileOpen) {
        return;
      }

      if (!selectedProject) {
        onFileOpen(filePath);
        return;
      }

      try {
        const data = await gitGet<GitFileWithDiffResponse>('file-with-diff', {
          project: selectedProject.projectId,
          file: filePath,
        });

        if (data.error) {
          console.error('Error fetching file with diff:', data.error);
          onFileOpen(filePath);
          return;
        }

        onFileOpen(filePath, {
          old_string: data.oldContent || '',
          new_string: data.currentContent || '',
        });
      } catch (error) {
        console.error('Error opening file:', error);
        onFileOpen(filePath);
      }
    },
    [onFileOpen, selectedProject],
  );

  const refreshAll = useCallback(() => {
    void fetchGitStatus();
    void fetchBranches();
    void fetchRemoteStatus();
  }, [fetchBranches, fetchGitStatus, fetchRemoteStatus]);

  useEffect(() => {
    const controller = new AbortController();

    // Reset repository-scoped state when project changes to avoid stale UI.
    setCurrentBranch('');
    setBranches([]);
    setLocalBranches([]);
    setRemoteBranches([]);
    setGitStatus(null);
    setGitDiff({});
    setRecentCommits([]);
    setCommitDiffs({});
    setIsLoading(false);
    setOperationError(null);

    if (!selectedProject) {
      return () => {
        controller.abort();
      };
    }

    void fetchGitStatus(controller.signal);
    void fetchBranches();
    void fetchRemoteStatus();

    return () => {
      controller.abort();
    };
  }, [fetchBranches, fetchGitStatus, fetchRemoteStatus, selectedProject]);

  useEffect(() => {
    if (!selectedProject || activeView !== 'history') {
      return;
    }
    void fetchRecentCommits();
  }, [activeView, fetchRecentCommits, selectedProject]);

  return {
    gitStatus,
    gitDiff,
    isLoading,
    currentBranch,
    branches,
    localBranches,
    remoteBranches,
    recentCommits,
    commitDiffs,
    remoteStatus,
    isCreatingBranch,
    isFetching,
    isPulling,
    isPushing,
    isPublishing,
    isCreatingInitialCommit,
    operationError,
    clearOperationError,
    refreshAll,
    switchBranch,
    createBranch,
    deleteBranch,
    handleFetch,
    handlePull,
    handlePush,
    handlePublish,
    discardChanges,
    deleteUntrackedFile,
    stageFiles,
    unstageFiles,
    fetchCommitDiff,
    generateCommitMessage,
    commitChanges,
    createInitialCommit,
    openFile,
  };
}
