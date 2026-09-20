export type UpdateRow = {
  status?: string | null;
  latestVersion?: string | null;
  error?: string | null;
  configured?: boolean;
};

export function canCheckUpdate(updater?: { checkForUpdates?: unknown } | null): boolean {
  return Boolean(updater?.checkForUpdates);
}

export function nextUpdateAction(row?: UpdateRow | null): 'check' | 'download' | 'install' | 'wait' {
  if (row?.status === 'available') return 'download';
  if (row?.status === 'downloaded') return 'install';
  if (row?.status === 'checking' || row?.status === 'downloading' || row?.status === 'installing') return 'wait';
  return 'check';
}

export function checkUpdateLabel(row?: UpdateRow | null): string {
  if (row?.status === 'available') return '下载更新';
  if (row?.status === 'downloaded') return '装上更新';
  if (row?.status === 'checking' || row?.status === 'downloading' || row?.status === 'installing') return '正在更新';
  return '检查更新';
}

export function checkUpdateToast(row?: UpdateRow | null): string {
  if (row?.status === 'up-to-date') return '已经是最新';
  if (row?.status === 'available') return row.latestVersion ? `有新版本 ${row.latestVersion}` : '有新版本';
  if (row?.status === 'downloaded') return '更新已下载，可以装上';
  if (row?.status === 'development-build') return '开发构建不能检查更新';
  if (row?.status === 'authentication-required') return '检查更新需要授权';
  if (row?.status === 'checking') return '正在检查更新';
  if (row?.status === 'downloading') return '正在下载更新';
  if (row?.status === 'installing') return '正在装上更新';
  if (row?.error) return row.error;
  if (row?.status === 'error') return '检查更新失败';
  return '已检查更新';
}
