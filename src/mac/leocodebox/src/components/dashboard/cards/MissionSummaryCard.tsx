import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { MissionCard } from '../dashboardTypes';

import { DashCard, DashCardTitle, DashEmpty, DashError, DashSkeleton } from './dashShared';

type MissionSummaryCardProps = {
  missions: MissionCard[] | null;
  loading: boolean;
  error: string | null;
  onOpenMissions: () => void;
  /** Re-fetches after a load failure. Without it the 重试 button used to
   *  navigate away instead of retrying. */
  onRetry?: () => void;
  delay?: number;
};

const COLUMNS: Array<{ key: MissionCard['status']; tone: string }> = [
  { key: 'backlog', tone: 'text-muted-foreground' },
  { key: 'running', tone: 'text-success' },
  { key: 'review', tone: 'text-warning' },
  { key: 'done', tone: 'text-foreground' },
];

export default function MissionSummaryCard({ missions, loading, error, onOpenMissions, onRetry, delay = 0 }: MissionSummaryCardProps) {
  const { t } = useTranslation();

  const counts = useMemo(() => {
    const map: Record<string, number> = { backlog: 0, running: 0, review: 0, done: 0 };
    for (const card of missions ?? []) {
      if (card.status in map) map[card.status] += 1;
    }
    return map;
  }, [missions]);

  const running = useMemo(
    () => (missions ?? []).filter((card) => card.status === 'running').slice(0, 3),
    [missions],
  );

  return (
    <DashCard delay={delay} interactive className="p-4">
      <DashCardTitle
        title={t('dashboard.missionsTitle', { defaultValue: 'Mission 看板' })}
        action={
          <button type="button" onClick={onOpenMissions} className="text-[12px] text-info transition-colors hover:text-info/80">
            {t('dashboard.viewAll', { defaultValue: '查看全部' })}
          </button>
        }
      />

      {loading ? (
        <DashSkeleton rows={2} />
      ) : error && !missions ? (
        <DashError message={error} onRetry={onRetry} />
      ) : (missions ?? []).length === 0 ? (
        <DashEmpty
          message={t('dashboard.missionsEmpty', { defaultValue: '还没有 Mission' })}
          actionLabel={t('dashboard.missionsEmptyCta', { defaultValue: '去创建' })}
          onAction={onOpenMissions}
        />
      ) : (
        <button type="button" onClick={onOpenMissions} className="block w-full text-left">
          <div className="grid grid-cols-4 gap-2 text-center">
            {COLUMNS.map((column) => (
              <div key={column.key} className="rounded-lg bg-secondary/60 px-2 py-2">
                <div className={`text-[18px] font-medium ${column.tone}`}>{counts[column.key]}</div>
                <div className="text-[12px] text-muted-foreground">
                  {t(`dashboard.missionStatus.${column.key}`, { defaultValue: column.key })}
                </div>
              </div>
            ))}
          </div>

          {running.length > 0 && (
            <div className="mt-3 space-y-1.5 border-t border-border pt-3">
              {running.map((card) => (
                <div key={card.id} className="flex items-center gap-2 text-[12px]">
                  <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-success" />
                  <span className="truncate text-foreground">{card.title}</span>
                </div>
              ))}
            </div>
          )}
        </button>
      )}
    </DashCard>
  );
}
