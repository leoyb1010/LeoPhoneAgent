export type NoticeSession = {
  key: string;
  machine: string;
  id: string;
  status: string;
  title: string;
  command?: string;
  approvalId?: string;
  choices?: string[];
};

export type SessionNotice = {
  key: string;
  machine: string;
  id: string;
  kind: 'need' | 'failed' | 'done';
  title: string;
  body: string;
  approvalId?: string;
  choices?: string[];
};

export type PendingApproval = { approvalId: string; command: string; choices: string[] };
export type ApprovalAction = { choice: string; label: string };

export function firstPendingApproval(input: {
  pending_approvals?: Array<{ approval_id?: string; command?: string; choices?: string[] }> | null;
} | null | undefined): PendingApproval | null {
  const first = input?.pending_approvals?.[0];
  const approvalId = String(first?.approval_id ?? '').trim();
  if (!approvalId) return null;
  const choices = Array.isArray(first?.choices) && first.choices.length > 0
    ? first.choices.map(String)
    : ['once', 'deny'];
  return { approvalId, command: String(first?.command ?? ''), choices };
}

export function approvalChoiceActions(choices: readonly string[]): ApprovalAction[] {
  const out: ApprovalAction[] = [];
  if (choices.includes('once')) out.push({ choice: 'once', label: '批准一次' });
  if (choices.includes('session')) out.push({ choice: 'session', label: '本会话允许' });
  if (choices.includes('always')) out.push({ choice: 'always', label: '总是允许' });
  if (choices.includes('deny')) out.push({ choice: 'deny', label: '拒绝' });
  return out;
}

/** 系统通知只留批准一次 / 拒绝,展开才好按。 */
export function noticeBannerActions(notice: { kind?: string; choices?: readonly string[] }): ApprovalAction[] {
  if (notice.kind !== 'need') return [];
  const all = approvalChoiceActions(notice.choices ?? ['once', 'deny']);
  return all.filter((row) => row.choice === 'once' || row.choice === 'deny');
}

export function noticeNotifyPayload(notice: SessionNotice): {
  title: string;
  body: string;
  sessionId: string;
  machine: string;
  approvalId?: string;
  actions?: ApprovalAction[];
} {
  const actions = noticeBannerActions(notice);
  return {
    title: notice.title,
    body: notice.body,
    sessionId: notice.id,
    machine: notice.machine,
    ...(notice.approvalId && actions.length ? { approvalId: notice.approvalId, actions } : {}),
  };
}

export function approvalToast(choice: string): string {
  if (choice === 'deny') return '已拒绝';
  if (choice === 'session' || choice === 'always') return '已批准,本会话内相同范围不再询问';
  return '已批准一次';
}

export function dockNeedBadge(sessions: ReadonlyArray<{ status: string }>): number {
  return sessions.filter((row) => row.status === 'waiting_for_approval').length;
}

function firstLine(text: string | undefined): string {
  return (text ?? '').trim().split('\n')[0] ?? '';
}

function needNotice(row: NoticeSession, title: string): SessionNotice {
  const command = firstLine(row.command);
  return {
    key: row.key,
    machine: row.machine,
    id: row.id,
    kind: 'need',
    title,
    body: command ? `需要确认：${command}` : '会话在等你批准',
    ...(row.approvalId ? { approvalId: row.approvalId, choices: row.choices ?? ['once', 'deny'] } : {}),
  };
}

/** 会话状态变了才通知。正在盯着这条且窗口在前就不再弹。 */
export function noticesFromSnapshot(input: {
  primed: boolean;
  prev: ReadonlyMap<string, string>;
  next: readonly NoticeSession[];
  activeKey: string | null;
  windowFocused: boolean;
}): { notices: SessionNotice[]; map: Map<string, string> } {
  const map = new Map(input.next.map((row) => [row.key, row.status]));
  if (!input.primed) {
    const pending = input.next.filter((row) => row.status === 'waiting_for_approval');
    if (!input.windowFocused && pending[0]) {
      const first = pending[0];
      return {
        notices: [needNotice(first, pending.length > 1 ? `${pending.length} 条会话需要你` : (first.title || '需要你'))],
        map,
      };
    }
    return { notices: [], map };
  }

  const notices: SessionNotice[] = [];
  for (const row of input.next) {
    const prev = input.prev.get(row.key);
    if (prev == null || prev === row.status) continue;
    const watchingHere = input.windowFocused && input.activeKey === row.key;
    if (row.status === 'waiting_for_approval') {
      if (!watchingHere) notices.push(needNotice(row, row.title || '需要你'));
      continue;
    }
    if (row.status === 'failed' && !watchingHere) {
      notices.push({
        key: row.key, machine: row.machine, id: row.id, kind: 'failed',
        title: row.title || '会话失败', body: '这条会话失败了',
      });
      continue;
    }
    if ((row.status === 'idle' || row.status === 'completed') && (prev === 'running' || prev === 'starting') && !input.windowFocused) {
      notices.push({
        key: row.key, machine: row.machine, id: row.id, kind: 'done',
        title: row.title || '会话完成', body: '模型跑完了',
      });
    }
  }
  return { notices, map };
}

/** 系统通知点进来的路径:/session/<id> 或 /session/<machine>:<id> */
export function sessionPathTarget(pathname: string): { machine: string; id: string } | null {
  const match = pathname.match(/^\/session\/([^/?#]+)$/);
  if (!match?.[1]) return null;
  let raw = match[1];
  try { raw = decodeURIComponent(raw); } catch { /* 用原值 */ }
  const slash = raw.indexOf(':');
  if (slash > 0) return { machine: raw.slice(0, slash), id: raw.slice(slash + 1) };
  return raw ? { machine: 'local', id: raw } : null;
}
