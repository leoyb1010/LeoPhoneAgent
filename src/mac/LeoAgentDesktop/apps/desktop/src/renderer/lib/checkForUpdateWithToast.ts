import { toast } from '@/lib/toast';

type Translate = (key: string) => string;

export async function checkForUpdateWithToast(t: Translate): Promise<void> {
  const { result } = await window.electronAPI.checkForUpdate();
  switch (result) {
    case 'idle':
      toast.success(t('titleBar.updateCheckToast.alreadyLatest'));
      break;
    case 'downloading':
      toast.warning(t('titleBar.updateCheckToast.downloading'));
      break;
    case 'ready':
      toast.success(t('titleBar.updateCheckToast.ready'));
      break;
    case 'manifest_failed':
      toast.error(t('titleBar.updateCheckToast.manifestFailed'));
      break;
    case 'download_failed':
      toast.error(t('titleBar.updateCheckToast.downloadFailed'));
      break;
    case 'manual_download':
      toast.warning(t('titleBar.updateCheckToast.manualDownload'));
      break;
  }
}
