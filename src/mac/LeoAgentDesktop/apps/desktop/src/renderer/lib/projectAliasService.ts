import type { ProjectAlias } from '../../shared/projectAliases';
import { ApiError } from '@/lib/httpClient';
import { extractIpcError } from '@/utils/ipcError';

function wrap<T>(p: Promise<T>): Promise<T> {
  return p.catch((err: unknown) => {
    const ipcError = extractIpcError(err);
    if (ipcError) {
      throw new ApiError(ipcError.code, 0, ipcError.message);
    }
    if (err instanceof Error) {
      throw new ApiError('UNKNOWN', 0, err.message);
    }
    throw new ApiError('UNKNOWN', 0, String(err));
  });
}

export async function listProjectAliases(): Promise<ProjectAlias[]> {
  return wrap(window.electronAPI.localDb.projectAliases.list());
}

export async function setProjectAlias(projectKey: string, alias: string): Promise<ProjectAlias | null> {
  return wrap(window.electronAPI.localDb.projectAliases.set({ projectKey, alias }));
}

export async function deleteProjectAlias(projectKey: string): Promise<void> {
  return wrap(window.electronAPI.localDb.projectAliases.delete(projectKey));
}

export function onProjectAliasesChanged(cb: () => void): () => void {
  return window.electronAPI.localDb.projectAliases.onChanged(cb);
}
