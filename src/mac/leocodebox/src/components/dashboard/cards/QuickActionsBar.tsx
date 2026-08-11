import { useTranslation } from 'react-i18next';

import { useVersionCheck } from '../../../hooks/useVersionCheck';

import { DashCard } from './dashShared';

type QuickActionsBarProps = {
  onRunDoctor: () => void;
  delay?: number;
};

/**
 * Flat action strip along the bottom of the dashboard.
 *
 * Only actions that actually do something live here. A 回收站 button (which had
 * no click handler at all, and counted a response field the API never returns)
 * and a 配置备份 link (which opened raw JSON in a new tab) were removed along
 * with their polling — both features already have a real home in
 * 设置 → 恢复 (RecoverySection).
 */
export default function QuickActionsBar({ onRunDoctor, delay = 0 }: QuickActionsBarProps) {
  const { t } = useTranslation();
  const { checkForUpdates } = useVersionCheck();

  const buttonClass = 'inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-[13px] text-foreground transition-colors hover:bg-accent/60';

  return (
    <DashCard delay={delay} className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={onRunDoctor} className={buttonClass}>
          {t('dashboard.actionDoctor', { defaultValue: '运行 Doctor' })}
        </button>
        <button type="button" onClick={() => void checkForUpdates()} className={buttonClass}>
          {t('dashboard.actionCheckUpdate', { defaultValue: '检查更新' })}
        </button>
      </div>
    </DashCard>
  );
}
