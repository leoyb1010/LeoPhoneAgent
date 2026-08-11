import type { ConfirmActionType, FileStatusCode, GitStatusGroupEntry } from '../types/types';

export const DEFAULT_BRANCH = 'main';
// High enough for the commit graph to show meaningful branch structure.
export const RECENT_COMMITS_LIMIT = 50;

export const FILE_STATUS_GROUPS: GitStatusGroupEntry[] = [
  { key: 'modified', status: 'M' },
  { key: 'added', status: 'A' },
  { key: 'deleted', status: 'D' },
  { key: 'untracked', status: 'U' },
];

export const FILE_STATUS_LABELS: Record<FileStatusCode, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  U: 'Untracked',
};

export const FILE_STATUS_BADGE_CLASSES: Record<FileStatusCode, string> = {
  M: 'bg-warning text-warning dark:bg-warning/40 dark:text-warning border-warning dark:border-warning/50',
  A: 'bg-success text-success dark:bg-success/40 dark:text-success border-success dark:border-success/50',
  D: 'bg-destructive text-destructive dark:bg-destructive/40 dark:text-destructive border-destructive dark:border-destructive/50',
  U: 'bg-muted text-muted-foreground border-border',
};

export const CONFIRMATION_TITLES: Record<ConfirmActionType, string> = {
  discard: 'Discard Changes',
  delete: 'Delete File',
  commit: 'Confirm Action',
  pull: 'Confirm Pull',
  push: 'Confirm Push',
  publish: 'Publish Branch',
  revertLocalCommit: 'Revert Local Commit',
  deleteBranch: 'Delete Branch',
};

export const CONFIRMATION_ACTION_LABELS: Record<ConfirmActionType, string> = {
  discard: 'Discard',
  delete: 'Delete',
  commit: 'Confirm',
  pull: 'Pull',
  push: 'Push',
  publish: 'Publish',
  revertLocalCommit: 'Revert Commit',
  deleteBranch: 'Delete',
};

export const CONFIRMATION_BUTTON_CLASSES: Record<ConfirmActionType, string> = {
  discard: 'bg-destructive hover:bg-destructive',
  delete: 'bg-destructive hover:bg-destructive',
  commit: 'bg-primary hover:bg-primary/90',
  pull: 'bg-success hover:bg-success',
  push: 'bg-warning hover:bg-warning',
  publish: 'bg-purple-600 hover:bg-purple-700',
  revertLocalCommit: 'bg-warning hover:bg-warning',
  deleteBranch: 'bg-destructive hover:bg-destructive',
};

export const CONFIRMATION_ICON_CONTAINER_CLASSES: Record<ConfirmActionType, string> = {
  discard: 'bg-destructive dark:bg-destructive/30',
  delete: 'bg-destructive dark:bg-destructive/30',
  commit: 'bg-warning dark:bg-warning/30',
  pull: 'bg-warning dark:bg-warning/30',
  push: 'bg-warning dark:bg-warning/30',
  publish: 'bg-warning dark:bg-warning/30',
  revertLocalCommit: 'bg-warning dark:bg-warning/30',
  deleteBranch: 'bg-destructive dark:bg-destructive/30',
};
