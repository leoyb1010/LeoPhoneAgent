import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GitBranch, GitMerge, Play, RotateCcw, Check, Trash2, Plus, RefreshCw, MessageSquare } from 'lucide-react';

import { apiClient } from '../../../utils/apiClient';
import { Button, Input } from '../../../shared/view/ui';
import type { Project } from '../../../types/app';

type MissionStatus = 'backlog' | 'running' | 'review' | 'done' | 'discarded';

type MissionCard = {
  id: string;
  projectPath: string;
  title: string;
  goal: string;
  provider: string;
  slot: string | null;
  worktreeId: string | null;
  sessionId: string | null;
  status: MissionStatus;
  costUsd: number | null;
  updatedAt: string;
};

/** Jump from a mission card into its chat session. `sendGoal` sends the card
 * goal as the first prompt (used by "开工"); the open button reuses it with
 * `sendGoal: false` to just surface the running session. */
export type OpenMissionSession = (opts: {
  sessionId: string;
  goal: string;
  provider: string;
  sendGoal: boolean;
}) => void;

type MissionsViewProps = {
  selectedProject: Project;
  onOpenMissionSession?: OpenMissionSession;
};

const COLUMNS: { status: MissionStatus; labelKey: string; label: string }[] = [
  { status: 'backlog', labelKey: 'missions.columns.backlog', label: '待办' },
  { status: 'running', labelKey: 'missions.columns.running', label: '进行中' },
  { status: 'review', labelKey: 'missions.columns.review', label: '待审' },
  { status: 'done', labelKey: 'missions.columns.done', label: '完成' },
];

export default function MissionsView({ selectedProject, onOpenMissionSession }: MissionsViewProps) {
  const { t } = useTranslation('chat');
  const projectPath = selectedProject.fullPath || selectedProject.path || '';
  const [cards, setCards] = useState<MissionCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiClient.get<{ cards?: MissionCard[] }>('/api/leocodebox/missions', { projectPath });
      setCards(Array.isArray(data.cards) ? data.cards : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  useEffect(() => { void load(); }, [load]);

  const act = useCallback(async (fn: () => Promise<unknown>, id?: string) => {
    setBusyId(id ?? 'new');
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }, [load]);

  const createCard = () => act(async () => {
    await apiClient.post('/api/leocodebox/missions', { projectPath, title: title.trim(), goal: goal.trim() });
    setTitle('');
    setGoal('');
  });

  const discardCard = (card: MissionCard) => {
    const force = card.worktreeId ? window.confirm(t('missions.discardConfirm', { defaultValue: '该任务有未提交改动,确认丢弃并删除 worktree?' })) : true;
    if (!force && card.worktreeId) return;
    return act(() => apiClient.post(`/api/leocodebox/missions/${card.id}/discard?force=${force ? 'true' : 'false'}`), card.id);
  };

  const openAction = (card: MissionCard) => ({
    key: 'open',
    icon: MessageSquare,
    label: t('missions.actions.open', { defaultValue: '打开会话' }),
    run: () => { if (card.sessionId) onOpenMissionSession?.({ sessionId: card.sessionId, goal: card.goal, provider: card.provider, sendGoal: false }); },
  });

  const cardActions = (card: MissionCard) => {
    switch (card.status) {
      case 'backlog':
        return [{
          key: 'start', icon: Play, label: t('missions.actions.start', { defaultValue: '开工' }),
          run: () => act(async () => {
            // Starting a card creates its bound session server-side; jump into
            // that chat and send the goal as the first prompt so the agent runs.
            const resp = await apiClient.post<{ card?: MissionCard }>(`/api/leocodebox/missions/${card.id}/start`);
            if (resp?.card?.sessionId) {
              onOpenMissionSession?.({ sessionId: resp.card.sessionId, goal: resp.card.goal, provider: resp.card.provider, sendGoal: true });
            }
          }, card.id),
        }];
      case 'running':
        return [
          { key: 'review', icon: Check, label: t('missions.actions.toReview', { defaultValue: '送审' }), run: () => act(() => apiClient.post(`/api/leocodebox/missions/${card.id}/transition`, { to: 'review' }), card.id) },
          openAction(card),
        ];
      case 'review':
        return [
          ...(card.worktreeId ? [{
            key: 'merge', icon: GitMerge, label: t('missions.actions.merge', { defaultValue: '合并完成' }),
            run: () => act(async () => {
              // The board's L4 close: merge the card's worktree back into its
              // base branch, then mark the card done. The server previews first
              // and refuses on conflicts, so this never force-merges.
              const resp = await apiClient.post<{ merged?: boolean; conflicts?: string[] }>(`/api/leocodebox/worktrees/${card.worktreeId}/merge`);
              if (resp?.merged) {
                await apiClient.post(`/api/leocodebox/missions/${card.id}/complete`);
              } else {
                const files = (resp?.conflicts ?? []).join(', ');
                throw new Error(t('missions.mergeConflict', { defaultValue: '合并存在冲突,请先在会话中解决:{{files}}', files }));
              }
            }, card.id),
          }] : []),
          { key: 'done', icon: Check, label: t('missions.actions.complete', { defaultValue: '完成' }), run: () => act(() => apiClient.post(`/api/leocodebox/missions/${card.id}/complete`), card.id) },
          { key: 'retry', icon: RotateCcw, label: t('missions.actions.retry', { defaultValue: '重试' }), run: () => act(() => apiClient.post(`/api/leocodebox/missions/${card.id}/retry`), card.id) },
          openAction(card),
        ];
      default:
        return [];
    }
  };

  if (!projectPath) {
    return <div className="p-6 text-sm text-muted-foreground">{t('missions.noProject', { defaultValue: '请先在左侧选择一个项目。' })}</div>;
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-shrink-0 border-b border-border px-4 py-3">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium text-foreground">{t('missions.title', { defaultValue: '任务看板' })}</h2>
          <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('missions.titlePlaceholder', { defaultValue: '任务标题' })} className="sm:max-w-[220px]" />
          <Input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder={t('missions.goalPlaceholder', { defaultValue: '目标(发给智能体的任务描述)' })} className="flex-1" />
          <Button size="sm" onClick={createCard} disabled={!title.trim() || !goal.trim() || busyId === 'new'}>
            <Plus className="mr-1 h-4 w-4" />{t('missions.addCard', { defaultValue: '新建' })}
          </Button>
        </div>
        {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
      </div>

      <div className="grid flex-1 grid-cols-1 gap-3 overflow-auto p-4 sm:grid-cols-2 lg:grid-cols-4">
        {COLUMNS.map((col) => {
          const columnCards = cards.filter((c) => c.status === col.status);
          return (
            <div key={col.status} className="flex min-h-0 flex-col rounded-lg bg-muted/30">
              <div className="flex items-center justify-between px-3 py-2 text-xs font-medium text-muted-foreground">
                <span>{t(col.labelKey, { defaultValue: col.label })}</span>
                <span className="rounded-full bg-muted px-1.5">{columnCards.length}</span>
              </div>
              <div className="flex flex-col gap-2 overflow-auto px-2 pb-2">
                {columnCards.map((card) => (
                  <div key={card.id} className="rounded-md border border-border bg-background p-3 shadow-sm">
                    <div className="mb-1 text-sm font-medium text-foreground">{card.title}</div>
                    <div className="mb-2 line-clamp-3 text-xs text-muted-foreground">{card.goal}</div>
                    <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                      <span className="rounded-md bg-muted px-1.5 py-0.5">{card.provider}</span>
                      {card.slot && <span className="rounded-md bg-info/15 px-1.5 py-0.5 text-info">{card.slot}</span>}
                      {card.worktreeId && <span className="inline-flex items-center gap-0.5 rounded-md bg-muted px-1.5 py-0.5"><GitBranch className="h-3 w-3" />wt</span>}
                      {card.costUsd != null && <span className="rounded-md bg-success/15 px-1.5 py-0.5 text-success">${card.costUsd.toFixed(2)}</span>}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {cardActions(card).map((action) => (
                        <Button key={action.key} variant="secondary" size="sm" className="h-6 px-2 text-[11px]" disabled={busyId === card.id} onClick={action.run}>
                          <action.icon className="mr-1 h-3 w-3" />{action.label}
                        </Button>
                      ))}
                      {card.status !== 'discarded' && (
                        <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px] text-destructive" disabled={busyId === card.id} onClick={() => discardCard(card)}>
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
                {columnCards.length === 0 && <div className="px-2 py-3 text-center text-[11px] text-muted-foreground/60">—</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
