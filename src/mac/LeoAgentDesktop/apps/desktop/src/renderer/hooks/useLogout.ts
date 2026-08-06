import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '@/contexts/AuthContext';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';

export function useLogout(): { handleLogout: () => Promise<void> } {
  const { logout } = useAuth();
  const { confirm } = useConfirmDialog();
  const { t } = useTranslation();

  const handleLogout = useCallback(async () => {
    const confirmed = await confirm({
      title: t('logic.confirm.logoutTitle'),
      description: t('logic.confirm.logoutDescription'),
      confirmText: t('logic.confirm.logoutConfirm'),
      cancelText: t('logic.confirm.cancel'),
    });
    if (confirmed) {
      await logout();
    }
  }, [logout, confirm, t]);

  return { handleLogout };
}
