export function appFolderState(appLike, platform = process.platform) {
  if (platform !== 'darwin' || typeof appLike?.isInApplicationsFolder !== 'function') {
    return { in: false, can: false };
  }
  return { in: Boolean(appLike.isInApplicationsFolder()), can: true };
}

export function shouldReplaceExistingApp(conflictType) {
  return conflictType !== 'exists' && conflictType !== 'existsAndRunning';
}
