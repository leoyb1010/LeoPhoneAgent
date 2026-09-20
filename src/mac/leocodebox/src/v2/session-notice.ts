export type NoticeSession = {
  key: string;
  machine: string;
  id: string;
  status: string;
  title: string;
  command?: string;
};

export type SessionNotice = {
  key: string;
  machine: string;
  id: string;
  kind: 'need' | 'failed' | 'done';
  title: string;
  body: string;
};

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
