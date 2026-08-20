import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../lib/utils';
import SessionProviderLogo from '../llm-logo-provider/SessionProviderLogo';
import type { Project, ProjectSession } from '../../types/app';
import type { SessionActivityMap } from '../../hooks/useSessionProtection';

import type { FleetMachine } from './useFleetSnapshot';

export type RailRow = {
  key: string;
  id: string;
  title: string;
  meta: string;
  provider: string;
  live: boolean;
  needsApproval: boolean;
  /** 远程会话带机器名,点击走接管而不是本地打开。 */
  remote: FleetMachine | null;
  duration: string;
  /** 排序用:本机会话取最后活动时间,远程会话没有时间戳,统一排在本机之后。 */
  sortAt: number;
};

type SessionRailProps = {
  projects: Project[];
  selectedSessionId: string | null;
  activeSessions: SessionActivityMap;
  /**
   * 当前真的有工具授权在等你点头的会话 id。
   *
   * 这里刻意**不用** attentionSessionIds —— 那个集合的语义是"这个非当前会话刚有过
   * 任何动静",拿它渲染"待审批"就会出现挂着橙色标签、点进去什么都没有的假标签。
   */
  approvalSessionIds: ReadonlySet<string>;
  remotes: FleetMachine[];
  localName: string;
  onSelectLocal: (session: ProjectSession, project: Project) => void;
  onTakeOverRemote: (machine: FleetMachine, sessionId: string) => void;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function sessionTimestamp(session: ProjectSession): number {
  const raw = session.lastActivity ?? session.updated_at ?? session.createdAt ?? session.created_at;
  if (typeof raw !== 'string') return 0;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60 ? `${minutes % 60}m` : ''}`;
}

/**
 * 264px 会话列表 —— 取代原来的项目树侧栏。
 *
 * 工作台以对话为单位组织,不再以项目为单位:一个人一天关心的是"哪几件事
 * 在跑、哪件等我点头",而不是"哪个文件夹下面有哪些会话"。项目切换退到
 * ⌘K,列表只留两组:进行中、今天已完成。远程会话与本机会话同列,靠 meta
 * 里的机器名区分。
 */
export default function SessionRail({
  projects,
  selectedSessionId,
  activeSessions,
  approvalSessionIds,
  remotes,
  localName,
  onSelectLocal,
  onTakeOverRemote,
}: SessionRailProps) {
  const { t } = useTranslation();

  const { running, doneToday, lookup } = useMemo(() => {
    const now = Date.now();
    const rows: RailRow[] = [];
    const index = new Map<string, { session: ProjectSession; project: Project }>();

    for (const project of projects) {
      for (const session of project.sessions ?? []) {
        index.set(session.id, { session, project });
        const activity = activeSessions.get(session.id);
        const updatedAt = sessionTimestamp(session);
        const provider = String(session.__provider ?? session.provider ?? 'claude');
        rows.push({
          key: `local:${session.id}`,
          id: session.id,
          title: String(session.summary || session.title || session.name || t('workbench.untitledSession', { defaultValue: '未命名会话' })),
          meta: [localName || '本机', provider, project.displayName].filter(Boolean).join(' · '),
          provider,
          live: Boolean(activity),
          needsApproval: approvalSessionIds.has(session.id),
          remote: null,
          duration: activity ? formatDuration(now - activity.startedAt) : formatDuration(now - updatedAt),
          sortAt: activity ? activity.startedAt : updatedAt,
        });
      }
    }

    for (const machine of remotes) {
      for (const session of machine.sessions ?? []) {
        rows.push({
          key: `remote:${machine.name}:${session.session_id}`,
          id: session.session_id,
          title: String(session.cwd || session.session_id).split('/').filter(Boolean).pop()
            || session.session_id,
          meta: [machine.name, session.harness, session.status].filter(Boolean).join(' · '),
          provider: session.harness,
          live: ['starting', 'running', 'idle'].includes(String(session.status)),
          needsApproval: session.waiting_for_approval === true || session.status === 'waiting_for_approval',
          remote: machine,
          duration: '',
          sortAt: 0,
        });
      }
    }

    const isRunning = (row: RailRow) => row.live || row.needsApproval;
    // 等我点头的排最前 —— 这一列存在的意义就是别让审批干等着。
    const byUrgency = (a: RailRow, b: RailRow) =>
      Number(b.needsApproval) - Number(a.needsApproval) || b.sortAt - a.sortAt;

    return {
      running: rows.filter(isRunning).sort(byUrgency),
      doneToday: rows
        .filter((row) => !isRunning(row) && !row.remote && now - row.sortAt < DAY_MS)
        .sort((a, b) => b.sortAt - a.sortAt),
      lookup: index,
    };
  }, [projects, activeSessions, approvalSessionIds, remotes, localName, t]);

  const renderRow = (row: RailRow, dimmed: boolean) => (
    <button
      key={row.key}
      type="button"
      onClick={() => {
        if (row.remote) {
          onTakeOverRemote(row.remote, row.id);
          return;
        }
        const entry = lookup.get(row.id);
        if (entry) onSelectLocal(entry.session, entry.project);
      }}
      aria-current={row.id === selectedSessionId ? 'true' : undefined}
      className={cn('wb-session-row wb-anim-entry', row.id === selectedSessionId && 'is-active')}
    >
      <SessionProviderLogo provider={row.provider} className={dimmed ? 'h-[15px] w-[15px]' : 'h-[17px] w-[17px]'} />
      <span className="min-w-0 flex-1 text-left">
        <span className={cn('block truncate text-xs', dimmed ? 'font-medium text-muted-foreground' : 'font-semibold text-foreground')}>
          {row.title}
        </span>
        <span className="mt-0.5 block truncate text-[9.5px] text-wb-faint">{row.meta}</span>
      </span>
      {row.needsApproval && (
        <span className="flex-none rounded-md bg-warning px-1.5 py-0.5 text-[9.5px] font-bold text-warning-foreground">
          {t('workbench.needsApproval', { defaultValue: '待审批' })}
        </span>
      )}
      {row.live && !row.needsApproval && (
        <span aria-hidden className="flex flex-none gap-[3px]">
          <span className="wb-dot h-[3px] w-[3px] rounded-full bg-primary" />
          <span className="wb-dot-2 h-[3px] w-[3px] rounded-full bg-primary" />
          <span className="wb-dot-3 h-[3px] w-[3px] rounded-full bg-primary" />
        </span>
      )}
      {dimmed && row.duration && (
        <span className="flex-none font-mono text-[9.5px] text-wb-faint">{row.duration}</span>
      )}
    </button>
  );

  return (
    <nav
      aria-label={t('workbench.sessionListLabel', { defaultValue: '会话列表' })}
      className="flex w-[264px] flex-none flex-col gap-1 overflow-y-auto border-r border-border py-4 pl-3 pr-2.5"
    >
      <p className="px-2.5 pb-2 font-mono text-[9.5px] tracking-[0.18em] text-wb-faint">
        {t('workbench.groupRunning', { defaultValue: '进行中' })}
      </p>
      {running.length === 0 ? (
        <p className="px-2.5 pb-1 text-[10.5px] text-wb-faint">
          {t('workbench.noRunning', { defaultValue: '没有进行中的会话,用上面的指挥条开一个。' })}
        </p>
      ) : (
        running.map((row) => renderRow(row, false))
      )}

      <p className="px-2.5 pb-2 pt-4 font-mono text-[9.5px] tracking-[0.18em] text-wb-faint">
        {t('workbench.groupDoneToday', { defaultValue: '今天 · 已完成' })}
      </p>
      {doneToday.length === 0 ? (
        <p className="px-2.5 text-[10.5px] text-wb-faint">
          {t('workbench.noDoneToday', { defaultValue: '今天还没有完成的会话。' })}
        </p>
      ) : (
        doneToday.map((row) => renderRow(row, true))
      )}
    </nav>
  );
}
