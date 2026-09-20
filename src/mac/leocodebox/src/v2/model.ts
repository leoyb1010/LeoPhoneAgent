import type { HarnessEvent, SessionSummary } from './api';

// 把 harness 事件流折叠成"流水行"。一行一个对象:你 / 模型 / 工具 / 编辑 / 需要确认 / 系统。
// 这套折叠规则是三端共用的词汇(iOS 与 Android 的列表也按同样的语义画),别在这里加只有 Mac 才懂的行。

export type FlowRow =
  | { k: 'user'; key: string; text: string }
  | { k: 'ai'; key: string; text: string; streaming: boolean }
  | { k: 'tool'; key: string; toolUseId: string | null; tool: string; preview: string; output: string; running: boolean; error: boolean }
  | { k: 'edit'; key: string; toolUseId: string | null; tool: string; file: string; output: string; running: boolean; error: boolean }
  | { k: 'ap'; key: string; approvalId: string; title: string; command: string; tool: string; cwd: string; host: string; choices: string[] }
  | { k: 'sys'; key: string; text: string; tone: 'muted' | 'remote' | 'error' };

export type SessionView = {
  rows: FlowRow[];
  seq: number;
  status: string;
  policy: string;
  model: string | null;
  title: string;
  pendingApprovals: Map<string, FlowRow & { k: 'ap' }>;
};

export const POLICY_LABEL: Record<string, string> = {
  default: '默认审批', accept_edits: '接受编辑', plan: '计划模式', auto: '全自动',
};

export function emptyView(summary?: SessionSummary | null): SessionView {
  return {
    rows: [], seq: 0,
    status: summary?.status ?? 'starting',
    policy: summary?.policy ?? 'default',
    model: summary?.model ?? null,
    title: summary?.title ?? '',
    pendingApprovals: new Map(),
  };
}

let rowSeq = 0;
const nextKey = () => `r${++rowSeq}`;
const str = (v: unknown) => (v == null ? '' : String(v));

function closeStreaming(rows: FlowRow[]): FlowRow[] {
  const last = rows[rows.length - 1];
  if (last && last.k === 'ai' && last.streaming) return [...rows.slice(0, -1), { ...last, streaming: false }];
  return rows;
}

function isEditTool(tool: string): boolean {
  return tool === 'edit' || tool === 'write';
}

/** 纯函数:一条事件进来,返回新的视图。不认识的事件原样忽略,永远不抛。 */
export function applyEvent(view: SessionView, event: HarnessEvent): SessionView {
  const name = event.event;
  const seq = typeof event.seq === 'number' ? event.seq : view.seq;
  let rows = view.rows;
  let { status, policy, model, title } = view;
  const pendingApprovals = view.pendingApprovals;

  switch (name) {
    case 'session.created':
      model = typeof event.model === 'string' ? event.model : model;
      policy = typeof event.policy === 'string' ? event.policy : policy;
      break;
    case 'user.message': {
      const text = str(event.text);
      if (!title) title = text.replace(/\s+/g, ' ').trim().slice(0, 80);
      rows = [...closeStreaming(rows), { k: 'user', key: nextKey(), text }];
      status = 'running';
      break;
    }
    case 'message.delta': {
      const delta = str(event.delta);
      const last = rows[rows.length - 1];
      if (last && last.k === 'ai' && last.streaming) rows = [...rows.slice(0, -1), { ...last, text: last.text + delta }];
      else rows = [...rows, { k: 'ai', key: nextKey(), text: delta, streaming: true }];
      break;
    }
    case 'tool.started': {
      const tool = str(event.tool) || 'tool';
      const preview = str(event.preview);
      rows = closeStreaming(rows);
      rows = isEditTool(tool)
        ? [...rows, { k: 'edit', key: nextKey(), toolUseId: event.tool_use_id == null ? null : str(event.tool_use_id), tool, file: preview, output: '', running: true, error: false }]
        : [...rows, { k: 'tool', key: nextKey(), toolUseId: event.tool_use_id == null ? null : str(event.tool_use_id), tool, preview, output: '', running: true, error: false }];
      break;
    }
    case 'tool.completed': {
      const id = event.tool_use_id == null ? null : str(event.tool_use_id);
      let index = -1;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const row = rows[i];
        if ((row.k === 'tool' || row.k === 'edit') && row.running && (id == null || row.toolUseId == null || row.toolUseId === id)) { index = i; break; }
      }
      if (index >= 0) {
        const row = rows[index] as FlowRow & { k: 'tool' | 'edit' };
        rows = [...rows.slice(0, index), { ...row, running: false, error: Boolean(event.error), output: str(event.output) }, ...rows.slice(index + 1)];
      }
      break;
    }
    case 'approval.request': {
      const approvalId = str(event.approval_id ?? event.request_id);
      const row: FlowRow & { k: 'ap' } = {
        k: 'ap', key: nextKey(), approvalId,
        title: str(event.title), command: str(event.command), tool: str(event.tool), cwd: str(event.cwd), host: str(event.host),
        choices: Array.isArray(event.choices) && event.choices.length > 0 ? event.choices.map(String) : ['once', 'deny'],
      };
      rows = [...closeStreaming(rows), row];
      pendingApprovals.set(approvalId, row);
      status = 'waiting_for_approval';
      break;
    }
    case 'approval.responded': {
      const approvalId = str(event.approval_id);
      const choice = str(event.choice);
      pendingApprovals.delete(approvalId);
      const label = choice === 'deny' ? '已拒绝' : choice === 'session' || choice === 'always' ? '已批准,本会话内相同范围不再询问' : '已批准一次';
      rows = rows.map((row) => (row.k === 'ap' && row.approvalId === approvalId
        ? { k: 'sys', key: row.key, text: `${label} · ${row.command.split('\n')[0]}`, tone: 'muted' }
        : row));
      if (pendingApprovals.size === 0) status = 'running';
      break;
    }
    case 'run.completed':
      rows = closeStreaming(rows);
      status = 'idle';
      break;
    case 'run.failed':
      rows = [...closeStreaming(rows), { k: 'sys', key: nextKey(), text: `失败:${humanizeError(str(event.error))}`, tone: 'error' }];
      status = 'failed';
      break;
    case 'run.cancelled':
      rows = [...closeStreaming(rows), { k: 'sys', key: nextKey(), text: '已停止 · 上下文保留,可以接着说', tone: 'muted' }];
      status = 'cancelled';
      break;
    case 'session.policy':
      policy = str(event.policy) || policy;
      rows = [...rows, { k: 'sys', key: nextKey(), text: `审批策略改为「${POLICY_LABEL[policy] ?? policy}」`, tone: 'muted' }];
      break;
    case 'session.model': {
      const next = `${str(event.provider)}/${str(event.model_id)}`;
      if (next !== '/') {
        model = next;
        rows = [...rows, { k: 'sys', key: nextKey(), text: `已切换到 ${str(event.model_id)} · 同一条会话继续,上下文不变`, tone: 'muted' }];
      }
      break;
    }
    case 'session.compacted':
      rows = [...rows, { k: 'sys', key: nextKey(), text: '已压缩:早先的轮次折成一条摘要,上下文变轻了', tone: 'muted' }];
      break;
    default:
      break;
  }
  return { rows, seq: Math.max(view.seq, seq), status, policy, model, title, pendingApprovals };
}

export function modelLabel(model: string | null | undefined): string {
  if (!model) return '默认模型';
  const slash = model.indexOf('/');
  return slash > 0 ? model.slice(slash + 1) : model;
}

export function providerOf(model: string | null | undefined): string {
  if (!model) return '';
  const slash = model.indexOf('/');
  return slash > 0 ? model.slice(0, slash) : '';
}

export type StatusDot = 'need' | 'run' | 'err' | 'idle' | 'off';

export function statusDot(status: string): StatusDot {
  if (status === 'waiting_for_approval') return 'need';
  if (status === 'running' || status === 'starting') return 'run';
  if (status === 'failed') return 'err';
  if (status === 'orphaned') return 'off';
  return 'idle';
}

export function relativeTime(ts: number | null | undefined): string {
  if (!ts) return '';
  const diff = Date.now() / 1000 - ts;
  if (diff < 45) return '刚刚';
  if (diff < 3600) return `${Math.max(1, Math.round(diff / 60))} 分钟前`;
  if (diff < 86400) return `${Math.round(diff / 3600)} 小时前`;
  if (diff < 86400 * 2) return '昨天';
  return `${Math.round(diff / 86400)} 天前`;
}

export function lastLine(summary: Pick<SessionSummary, 'status' | 'last_event' | 'pending_approvals'>): string {
  if (summary.status === 'waiting_for_approval') {
    const first = summary.pending_approvals?.[0];
    return `需要确认:${(first?.command ?? summary.last_event?.text ?? '').split('\n')[0]}`;
  }
  const ev = summary.last_event;
  if (!ev) return summary.status === 'orphaned' ? '上次运行留下的记录' : '';
  switch (ev.event) {
    case 'user.message': return `你:${ev.text}`;
    case 'tool.started': return `正在运行 ${ev.text}`;
    case 'run.completed': return '已完成';
    case 'run.failed': return `失败 · ${ev.text}`;
    case 'run.cancelled': return '已停止';
    default: return ev.text;
  }
}

/** pi 的报错是给终端用户看的英文 + 文件路径;这里翻成一句能行动的话。 */
export function humanizeError(raw: string): string {
  const text = (raw || '').trim();
  if (!text) return '未知错误';
  if (/no api key/i.test(text)) return '这个模型还没有登录或密钥 —— 到「设置」登录一个供应商后再试';
  if (/unknown (model|provider)/i.test(text)) return '这个模型不可用 —— 到「设置」里选一个已登录的模型';
  if (/exited with code/i.test(text)) return `内核进程退出(${text})`;
  return text.split('\n')[0].replace(/\s+See:.*$/i, '').slice(0, 200);
}
