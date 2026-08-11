import { useMemo } from 'react';
import { FolderKanban, Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ProjectSummary } from '../../../hooks/useDashboardData';

import { DashCard, DashCardTitle, DashEmpty, DashError, DashSkeleton } from './dashShared';

type ProjectsOverviewCardProps = {
  projects: ProjectSummary[] | null;
  loading: boolean;
  error: string | null;
  onOpenProjects: () => void;
  /** Re-fetches after a load failure. Without it the 重试 button used to
   *  navigate away instead of retrying. */
  onRetry?: () => void;
  delay?: number;
};

const PROVIDER_SHORT: Record<string, string> = {
  claude: 'C',
  codex: 'Cx',
  cursor: 'Cu',
  opencode: 'O',
  grok: 'G',
  gemini: 'Ge',
  hermes: 'H',
};

/** Compact projects overview: total count, starred, and per-project session chips. */
export default function ProjectsOverviewCard({ projects, loading, error, onOpenProjects, onRetry, delay = 0 }: ProjectsOverviewCardProps) {
  const { t } = useTranslation();

  const stats = useMemo(() => {
    const list = projects ?? [];
    const total = list.length;
    const starred = list.filter((p) => p.isStarred).length;
    const totalSessions = list.reduce(
      (sum, p) => sum + Object.values(p.providerCounts ?? {}).reduce((a, b) => a + (b || 0), 0),
      0,
    );
    // Top projects by session count.
    const top = [...list]
      .map((p) => ({
        ...p,
        sessions: Object.values(p.providerCounts ?? {}).reduce((a, b) => a + (b || 0), 0),
      }))
      .sort((a, b) => b.sessions - a.sessions)
      .slice(0, 4);
    return { total, starred, totalSessions, top };
  }, [projects]);

  return (
    <DashCard delay={delay} interactive className="p-4">
      <DashCardTitle
        title={t('dashboard.projectsTitle', { defaultValue: '项目概览' })}
        action={
          <button type="button" onClick={onOpenProjects} className="text-[12px] text-info transition-colors hover:text-info/80">
            {t('dashboard.viewAll', { defaultValue: '查看全部' })}
          </button>
        }
      />

      {loading ? (
        <DashSkeleton rows={3} />
      ) : error && !projects ? (
        <DashError message={error} onRetry={onRetry} />
      ) : stats.total === 0 ? (
        <DashEmpty
          message={t('dashboard.projectsEmpty', { defaultValue: '还没有项目' })}
          actionLabel={t('dashboard.projectsEmptyCta', { defaultValue: '去添加' })}
          onAction={onOpenProjects}
        />
      ) : (
        <button type="button" onClick={onOpenProjects} className="block w-full text-left">
          <div className="mb-3 grid grid-cols-3 gap-2">
            <div className="dash-stat rounded-lg px-2.5 py-2">
              <div className="text-[11px] text-muted-foreground">{t('dashboard.projectsTotal', { defaultValue: '项目' })}</div>
              <div className="text-[18px] font-medium tabular-nums text-foreground">{stats.total}</div>
            </div>
            <div className="dash-stat rounded-lg px-2.5 py-2">
              <div className="text-[11px] text-muted-foreground">{t('dashboard.projectsSessions', { defaultValue: '会话' })}</div>
              <div className="text-[18px] font-medium tabular-nums text-foreground">{stats.totalSessions}</div>
            </div>
            <div className="dash-stat rounded-lg px-2.5 py-2">
              <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <Star className="h-3 w-3 text-warning" />
                {t('dashboard.projectsStarred', { defaultValue: '星标' })}
              </div>
              <div className="text-[18px] font-medium tabular-nums text-foreground">{stats.starred}</div>
            </div>
          </div>

          <div className="space-y-1.5">
            {stats.top.map((project) => (
              <div key={project.projectId} className="flex items-center gap-2 rounded-md px-1 py-1 transition-colors hover:bg-accent/40">
                <FolderKanban className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">{project.displayName}</span>
                <span className="flex flex-shrink-0 items-center gap-1">
                  {Object.entries(project.providerCounts ?? {}).map(([provider, count]) =>
                    count > 0 ? (
                      <span key={provider} className="rounded-md bg-secondary px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground" title={provider}>
                        {PROVIDER_SHORT[provider] ?? provider.slice(0, 1)}·{count}
                      </span>
                    ) : null,
                  )}
                </span>
              </div>
            ))}
          </div>
        </button>
      )}
    </DashCard>
  );
}
