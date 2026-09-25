export type HarnessKind = {
  key: string
  name: string
}

export type HarnessSessionSummary = {
  id: string
  harness: string
  name: string
  cwd: string
  status: string
  seq: number
  waitingForApproval: boolean
  pendingApprovalId: string | null
  pendingApprovalCommand: string | null
}

export type EngineChunk =
  | { kind: "delta"; text: string }
  | { kind: "completed"; output: string }
  | { kind: "failed"; message: string }

export type HarnessEvent = {
  seq: number
  event: string
  text?: string
  delta?: string
  output?: string
  message?: string
  approval_id?: string
  command?: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function capabilitiesFromJson(json: unknown): HarnessKind[] {
  const obj = asRecord(json)
  if (!obj || !Array.isArray(obj.harnesses)) return []
  const out: HarnessKind[] = []
  for (const row of obj.harnesses) {
    const item = asRecord(row)
    if (!item || typeof item.key !== "string" || !item.key) continue
    out.push({
      key: item.key,
      name: typeof item.name === "string" && item.name ? item.name : item.key,
    })
  }
  return out
}

export function sessionSummaryFromJson(json: unknown): HarnessSessionSummary | null {
  const item = asRecord(json)
  if (!item || typeof item.session_id !== "string" || !item.session_id) return null
  const pendingRows = Array.isArray(item.pending_approvals) ? item.pending_approvals : []
  const pending = pendingRows.length > 0 ? asRecord(pendingRows[0]) : null
  return {
    id: item.session_id,
    harness: typeof item.harness === "string" ? item.harness : "",
    name: typeof item.name === "string" ? item.name : "",
    cwd: typeof item.cwd === "string" ? item.cwd : "",
    status: typeof item.status === "string" ? item.status : "unknown",
    seq: typeof item.seq === "number" ? item.seq : 0,
    waitingForApproval: item.waiting_for_approval === true,
    pendingApprovalId: pending && typeof pending.approval_id === "string" ? pending.approval_id : null,
    pendingApprovalCommand: pending && typeof pending.command === "string" ? pending.command : null,
  }
}

// 下面这段与 app/entry/src/main/ets/net/Protocol.ets 一字不差(protocol.test.mjs 会比对),改一边必须同时改另一边。
export class RemoteTask {
  id: string = '';
  label: string = '';
}

/**
 * 打开远程机器时可以接着看的任务:同一个 Agent、没结束的,最近的在前,最多 5 个
 * (菜单一共 6 格,留一格给「新任务」)。Mac 桌面上的任务(source 为 desktop)也在里面,点开即接管,
 * 和 iOS、安卓一样。手机端的列表没有时间戳、按先后排,所以先倒过来再按时间排。
 */
export function parseRemoteTasks(json: object, harness: string): RemoteTask[] {
  const rows = (json as Record<string, Object>)['sessions'];
  if (!Array.isArray(rows)) {
    return [];
  }
  const items = (rows as Record<string, Object>[]).slice().reverse()
    .sort((a: Record<string, Object>, b: Record<string, Object>) =>
      Number(b['updated_at'] ?? 0) - Number(a['updated_at'] ?? 0));
  const out: RemoteTask[] = [];
  for (let i = 0; i < items.length && out.length < 5; i++) {
    const item = items[i];
    const id = `${item['session_id'] ?? ''}`;
    const status = `${item['status'] ?? ''}`;
    if (!id || `${item['harness'] ?? ''}` !== harness || ['completed', 'failed', 'cancelled'].indexOf(status) >= 0) {
      continue;
    }
    const title = `${item['title'] ?? ''}`.trim();
    const name = title.length > 18 ? `${title.substring(0, 18)}…` :
      (title.length > 0 ? title : `任务 ${id.substring(Math.max(0, id.length - 4))}`);
    let word = status === 'running' ? '进行中' : (status === 'waiting_for_approval' ? '等你批准' : '空闲');
    if (`${item['source'] ?? ''}` === 'desktop') {
      word = status === 'running' ? 'Mac 上在跑' : 'Mac 桌面任务';
    }
    const task = new RemoteTask();
    task.id = id;
    task.label = `${name} · ${word}`;
    out.push(task);
  }
  return out;
}
