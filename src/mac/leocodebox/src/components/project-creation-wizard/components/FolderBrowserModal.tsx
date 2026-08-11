import { useCallback, useEffect, useMemo, useState } from 'react';
import { Eye, EyeOff, FolderOpen, FolderPlus, Loader2, Plus, X } from 'lucide-react';

import { Button, Input } from '../../../shared/view/ui';
import { browseFilesystemFolders, createFolderInFilesystem } from '../data/workspaceApi';
import { getParentPath, joinFolderPath } from '../utils/pathUtils';
import type { FolderSuggestion } from '../types';

type FolderBrowserModalProps = {
  isOpen: boolean;
  autoAdvanceOnSelect: boolean;
  onClose: () => void;
  onFolderSelected: (folderPath: string, advanceToConfirm: boolean) => void;
};

export default function FolderBrowserModal({
  isOpen,
  autoAdvanceOnSelect,
  onClose,
  onFolderSelected,
}: FolderBrowserModalProps) {
  const [currentPath, setCurrentPath] = useState('~');
  const [folders, setFolders] = useState<FolderSuggestion[]>([]);
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [showHiddenFolders, setShowHiddenFolders] = useState(false);
  const [showNewFolderInput, setShowNewFolderInput] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadFolders = useCallback(async (pathToLoad: string) => {
    setLoadingFolders(true);
    setError(null);

    try {
      const result = await browseFilesystemFolders(pathToLoad);
      setCurrentPath(result.path);
      setFolders(result.suggestions);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load folders');
    } finally {
      setLoadingFolders(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    loadFolders('~');
  }, [isOpen, loadFolders]);

  const visibleFolders = useMemo(
    () =>
      folders
        .filter((folder) => showHiddenFolders || !folder.name.startsWith('.'))
        .sort((firstFolder, secondFolder) =>
          firstFolder.name.toLowerCase().localeCompare(secondFolder.name.toLowerCase()),
        ),
    [folders, showHiddenFolders],
  );

  const resetNewFolderState = () => {
    setShowNewFolderInput(false);
    setNewFolderName('');
  };

  const handleClose = () => {
    setError(null);
    resetNewFolderState();
    onClose();
  };

  const handleCreateFolder = useCallback(async () => {
    if (!newFolderName.trim()) {
      return;
    }

    setCreatingFolder(true);
    setError(null);

    try {
      const folderPath = joinFolderPath(currentPath, newFolderName);
      const createdPath = await createFolderInFilesystem(folderPath);
      resetNewFolderState();
      await loadFolders(createdPath);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Failed to create folder');
    } finally {
      setCreatingFolder(false);
    }
  }, [currentPath, loadFolders, newFolderName]);

  const parentPath = getParentPath(currentPath);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg border border-border bg-card shadow-elevation-3 dark:border-border dark:bg-muted">
        <div className="flex items-center justify-between border-b border-border p-4 dark:border-border">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-info dark:bg-info/50">
              <FolderOpen className="h-4 w-4 text-info dark:text-info" />
            </div>
            <h3 className="text-lg font-semibold text-muted-foreground dark:text-primary-foreground">Select Folder</h3>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowHiddenFolders((previous) => !previous)}
              className={`rounded-md p-2 transition-colors ${
                showHiddenFolders
                  ? 'bg-info/15 text-info dark:bg-info/25 dark:text-info'
                  : 'text-muted-foreground hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted dark:hover:text-muted-foreground'
              }`}
              title={showHiddenFolders ? 'Hide hidden folders' : 'Show hidden folders'}
            >
              {showHiddenFolders ? <Eye className="h-5 w-5" /> : <EyeOff className="h-5 w-5" />}
            </button>
            <button
              onClick={() => setShowNewFolderInput((previous) => !previous)}
              className={`rounded-md p-2 transition-colors ${
                showNewFolderInput
                  ? 'bg-info/15 text-info dark:bg-info/25 dark:text-info'
                  : 'text-muted-foreground hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted dark:hover:text-muted-foreground'
              }`}
              title="Create new folder"
            >
              <Plus className="h-5 w-5" />
            </button>
            <button
              onClick={handleClose}
              className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted dark:hover:text-muted-foreground"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {showNewFolderInput && (
          <div className="border-b border-border bg-info px-4 py-3 dark:border-border dark:bg-info/20">
            <div className="flex items-center gap-2">
              <Input
                type="text"
                value={newFolderName}
                onChange={(event) => setNewFolderName(event.target.value)}
                placeholder="New folder name"
                className="flex-1"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    handleCreateFolder();
                  }
                  if (event.key === 'Escape') {
                    resetNewFolderState();
                  }
                }}
                autoFocus
              />
              <Button
                size="sm"
                onClick={handleCreateFolder}
                disabled={!newFolderName.trim() || creatingFolder}
              >
                {creatingFolder ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create'}
              </Button>
              <Button size="sm" variant="ghost" onClick={resetNewFolderState}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {error && (
          <div className="px-4 pt-3">
            <p className="text-sm text-destructive dark:text-destructive">{error}</p>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4">
          {loadingFolders ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-1">
              {parentPath && (
                <button
                  onClick={() => loadFolders(parentPath)}
                  className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left hover:bg-muted dark:hover:bg-muted"
                >
                  <FolderOpen className="h-5 w-5 text-muted-foreground" />
                  <span className="font-medium text-muted-foreground dark:text-muted-foreground">..</span>
                </button>
              )}

              {visibleFolders.length === 0 ? (
                <div className="py-8 text-center text-muted-foreground dark:text-muted-foreground">
                  No subfolders found
                </div>
              ) : (
                visibleFolders.map((folder) => (
                  <div key={folder.path} className="flex items-center gap-2">
                    <button
                      onClick={() => loadFolders(folder.path)}
                      className="flex flex-1 items-center gap-3 rounded-lg px-4 py-3 text-left hover:bg-muted dark:hover:bg-muted"
                    >
                      <FolderPlus className="h-5 w-5 text-info" />
                      <span className="font-medium text-muted-foreground dark:text-primary-foreground">
                        {folder.name}
                      </span>
                    </button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onFolderSelected(folder.path, autoAdvanceOnSelect)}
                      className="px-3 text-xs"
                    >
                      Select
                    </Button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        <div className="border-t border-border dark:border-border">
          <div className="flex items-center gap-2 bg-muted px-4 py-3 dark:bg-muted/50">
            <span className="text-sm text-muted-foreground dark:text-muted-foreground">Path:</span>
            <code className="flex-1 truncate font-mono text-sm text-muted-foreground dark:text-primary-foreground">
              {currentPath}
            </code>
          </div>
          <div className="flex items-center justify-end gap-2 p-4">
            <Button variant="outline" onClick={handleClose}>
              Cancel
            </Button>
            <Button
              variant="outline"
              onClick={() => onFolderSelected(currentPath, autoAdvanceOnSelect)}
            >
              Use this folder
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
