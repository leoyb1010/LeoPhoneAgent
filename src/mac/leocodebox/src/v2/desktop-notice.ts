type DesktopNoticeTools = {
  setRunningBadge?: (count: number) => Promise<unknown>;
  notify?: (payload: {
    title: string;
    body: string;
    sessionId?: string;
    machine?: string;
    approvalId?: string;
    actions?: Array<{ choice: string; label: string }>;
  }) => Promise<{ shown?: boolean }>;
  onNoticeClick?: (callback: (row: { sessionId?: string | null; machine?: string | null }) => void) => () => void;
  onNoticeAction?: (callback: (row: {
    sessionId?: string | null;
    machine?: string | null;
    approvalId?: string | null;
    choice?: string | null;
  }) => void) => () => void;
};

function desktopTools(): DesktopNoticeTools | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.leocodeboxDesktopTools;
}

export async function setDockNeedBadge(count: number): Promise<void> {
  const setBadge = desktopTools()?.setRunningBadge;
  if (setBadge) await setBadge(count);
}

export async function showSessionNotice(input: {
  title: string;
  body: string;
  sessionId: string;
  machine: string;
  approvalId?: string;
  actions?: Array<{ choice: string; label: string }>;
}): Promise<void> {
  const notify = desktopTools()?.notify;
  if (notify) {
    await notify({
      title: input.title, body: input.body, sessionId: input.sessionId, machine: input.machine,
      ...(input.approvalId && input.actions?.length ? { approvalId: input.approvalId, actions: input.actions } : {}),
    });
    return;
  }
  if (typeof Notification === 'undefined' || Notification.permission === 'denied') return;
  if (Notification.permission === 'default') {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;
  }
  new Notification(input.title, { body: input.body });
}

export function onSessionNoticeClick(callback: (target: { machine: string; id: string }) => void): () => void {
  const listen = desktopTools()?.onNoticeClick;
  if (!listen) return () => undefined;
  return listen((row) => {
    const id = row.sessionId?.trim();
    if (!id) return;
    callback({ machine: row.machine?.trim() || 'local', id });
  });
}

export function onSessionNoticeAction(callback: (target: {
  machine: string;
  id: string;
  approvalId: string;
  choice: string;
}) => void): () => void {
  const listen = desktopTools()?.onNoticeAction;
  if (!listen) return () => undefined;
  return listen((row) => {
    const id = row.sessionId?.trim();
    const approvalId = row.approvalId?.trim();
    const choice = row.choice?.trim();
    if (!id || !approvalId || !choice) return;
    callback({ machine: row.machine?.trim() || 'local', id, approvalId, choice });
  });
}
