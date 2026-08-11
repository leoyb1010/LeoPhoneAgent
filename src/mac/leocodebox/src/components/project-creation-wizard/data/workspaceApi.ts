import { ApiError, apiClient  } from '../../../utils/apiClient';
import type {
  BrowseFilesystemResponse,
  CloneProgressEvent,
  CreateFolderResponse,
  CreateProjectPayload,
  CreateProjectResponse,
  CredentialsResponse,
  FolderSuggestion,
  TokenMode,
} from '../types';

type CloneWorkspaceParams = {
  workspacePath: string;
  githubUrl: string;
  tokenMode: TokenMode;
  selectedGithubToken: string;
  newGithubToken: string;
};

type CloneProgressHandlers = {
  onProgress: (message: string) => void;
};

const resolveCreateProjectErrorMessage = (responseData: CreateProjectResponse): string | null => {
  if (typeof responseData.details === 'string' && responseData.details.trim().length > 0) {
    return responseData.details;
  }

  if (typeof responseData.error === 'string' && responseData.error.trim().length > 0) {
    return responseData.error;
  }

  if (responseData.error && typeof responseData.error === 'object') {
    const errorObject = responseData.error as { message?: unknown; details?: unknown };

    if (typeof errorObject.details === 'string' && errorObject.details.trim().length > 0) {
      return errorObject.details;
    }

    if (typeof errorObject.message === 'string' && errorObject.message.trim().length > 0) {
      return errorObject.message;
    }

    if (
      errorObject.details
      && typeof errorObject.details === 'object'
      && typeof (errorObject.details as { projectPath?: unknown }).projectPath === 'string'
    ) {
      return `Project path already exists: ${(errorObject.details as { projectPath: string }).projectPath}`;
    }
  }

  if (typeof responseData.message === 'string' && responseData.message.trim().length > 0) {
    return responseData.message;
  }

  return null;
};

export const fetchGithubTokenCredentials = async () => {
  const data = await apiClient.get<CredentialsResponse>(
    '/api/settings/credentials',
    { type: 'github_token' },
  );

  return (data.credentials || []).filter((credential) => credential.is_active);
};

export const browseFilesystemFolders = async (pathToBrowse: string) => {
  const data = await apiClient.get<BrowseFilesystemResponse>(
    '/api/browse-filesystem',
    { path: pathToBrowse },
  );

  return {
    path: data.path || pathToBrowse,
    suggestions: (data.suggestions || []) as FolderSuggestion[],
  };
};

export const createFolderInFilesystem = async (folderPath: string) => {
  const data = await apiClient.post<CreateFolderResponse>('/api/create-folder', {
    path: folderPath,
  });

  return data.path || folderPath;
};

export const createProjectRequest = async (payload: CreateProjectPayload) => {
  try {
    const data = await apiClient.post<CreateProjectResponse>('/api/projects/create-project', payload);
    return data.project;
  } catch (error) {
    if (error instanceof ApiError && error.payload && typeof error.payload === 'object') {
      const message = resolveCreateProjectErrorMessage(error.payload as CreateProjectResponse);
      if (message) throw new Error(message);
    }
    throw error;
  }
};

export const cloneWorkspaceWithProgress = (
  params: CloneWorkspaceParams,
  handlers: CloneProgressHandlers,
) =>
  new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
    const abortController = new AbortController();
    let settled = false;

    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      abortController.abort();
      callback();
    };

    const handlePayload = (payload: CloneProgressEvent) => {
      if (payload.type === 'progress' && payload.message) {
        handlers.onProgress(payload.message);
        return;
      }

      if (payload.type === 'complete') {
        settle(() => resolve(payload.project));
        return;
      }

      if (payload.type === 'error') {
        settle(() => reject(new Error(payload.message || 'Failed to clone repository')));
      }
    };

    void apiClient.raw('/api/projects/clone-progress', {
      method: 'POST',
      body: JSON.stringify({
        path: params.workspacePath.trim(),
        githubUrl: params.githubUrl.trim(),
        githubTokenId: params.tokenMode === 'stored' && params.selectedGithubToken ? params.selectedGithubToken : null,
        newGithubToken: params.tokenMode === 'new' ? params.newGithubToken.trim() || null : null,
      }),
      signal: abortController.signal,
    }).then(async (response) => {
      if (!response.body) {
        throw new Error('Failed to start repository clone');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!settled) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() || '';
        for (const frame of frames) {
          const dataLine = frame.split(/\r?\n/).find((line) => line.startsWith('data: '));
          if (dataLine) handlePayload(JSON.parse(dataLine.slice(6)) as CloneProgressEvent);
        }
      }
      if (!settled) settle(() => reject(new Error('Clone stream ended before completion')));
    }).catch((error) => {
      if (!settled) settle(() => reject(error instanceof Error ? error : new Error(String(error))));
    });
  });
