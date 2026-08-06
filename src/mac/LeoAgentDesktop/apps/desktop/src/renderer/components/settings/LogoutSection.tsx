import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { useLogout } from '@/hooks/useLogout';
import { AccountDeletionSection } from './AccountDeletionSection';

export function LogoutSection() {
  const { mode } = useAuth();
  const { handleLogout } = useLogout();
  const { t } = useTranslation();

  // Local mode has no Cindy account or credentials to revoke. Keep logout and
  // account-deletion controls exclusive to authenticated cloud sessions.
  if (mode !== 'cloud') return null;

  return (
    <div className="flex flex-col gap-2.5">
      <button
        type="button"
        onClick={handleLogout}
        aria-label={t('settings.logout.aria')}
        className={cn(
          'flex h-[42px] w-full items-center justify-center rounded-full',
          'bg-[var(--settings-logout-bg)]',
          'border border-[var(--settings-logout-border)]',
          'text-13 font-medium text-[var(--settings-logout-text)]',
          'hover:bg-[var(--settings-logout-hover-bg)]',
          'transition-colors',
        )}
      >
        {t('settings.logout.button')}
      </button>
      <AccountDeletionSection />
    </div>
  );
}
