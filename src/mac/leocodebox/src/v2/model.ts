import type { HarnessEvent, SessionSummary } from './api';

// 把 harness 事件流折叠成"流水行"。一行一个对象:你 / 模型 / 工具 / 编辑 / 需要确认 / 系统。
// 这套折叠规则是三端共用的词汇(iOS 与 Android 的列表也按同样的语义画),别在这里加只有 Mac 才懂的行。

export type FlowRow =
  | { k: 'user'; key: string; text: string; mode?: UserTurnMode }
  | { k: 'ai'; key: string; text: string; streaming: boolean }
  | { k: 'think'; key: string; text: string; streaming: boolean }
  | { k: 'tool'; key: string; toolUseId: string | null; tool: string; preview: string; output: string; running: boolean; error: boolean }
  | { k: 'edit'; key: string; toolUseId: string | null; tool: string; file: string; output: string; running: boolean; error: boolean }
  | { k: 'ap'; key: string; approvalId: string; title: string; command: string; tool: string; cwd: string; host: string; choices: string[] }
  | { k: 'sys'; key: string; text: string; tone: 'muted' | 'remote' | 'error' };

export type BoundWindow = { app?: string; title?: string; snapshotId?: string };

export type SessionView = {
  rows: FlowRow[];
  seq: number;
  status: string;
  policy: string;
  model: string | null;
  thinking: string;
  title: string;
  window: BoundWindow | null;
  pendingApprovals: Map<string, FlowRow & { k: 'ap' }>;
};

export const POLICY_LABEL: Record<string, string> = {
  default: '默认审批', accept_edits: '接受编辑', plan: '计划模式', auto: '全自动',
};

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export const THINKING_LABEL: Record<string, string> = {
  off: '不思考', minimal: '极少', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最大',
};

export function emptyView(summary?: SessionSummary | null): SessionView {
  return {
    rows: [], seq: 0,
    status: summary?.status ?? 'starting',
    policy: summary?.policy ?? 'default',
    model: summary?.model ?? null,
    thinking: 'off',
    title: summary?.title ?? '',
    window: boundWindowFromUnknown(summary?.window),
    pendingApprovals: new Map(),
  };
}

const str = (v: unknown) => (v == null ? '' : String(v));

export function boundWindowFromUnknown(input: unknown): BoundWindow | null {
  if (!input || typeof input !== 'object') return null;
  const rec = input as Record<string, unknown>;
  const app = str(rec.app).trim();
  const title = str(rec.title).trim();
  const snapshotId = str(rec.snapshotId ?? rec.snapshot_id).trim();
  if (!app && !title && !snapshotId) return null;
  return {
    ...(app ? { app } : {}),
    ...(title ? { title } : {}),
    ...(snapshotId ? { snapshotId } : {}),
  };
}

export function windowBoundLabel(input: BoundWindow | null | undefined): string {
  if (!input) return '';
  const title = (input.title ?? '').trim();
  const app = (input.app ?? '').trim();
  if (title && app && title !== app) return `${app} · ${title}`;
  return title || app;
}

/** 本机没绑过也能点开去绑;绑过的提到前面;远程只标名字。 */
export function boundWindowChipKind(machine: string, label: string): 'raise' | 'bind' | 'label' | 'none' {
  if (machine === 'local') return label.trim() ? 'raise' : 'bind';
  return label.trim() ? 'label' : 'none';
}

/** 按钮文案:跑着时显示插话。首句仍由内核按「还没开过一轮」走 prompt。 */
export function composerShowsSteer(status: string): boolean {
  return status === 'running' || status === 'starting';
}

export function composerPlaceholder(cwdLabel: string, ended: boolean): string {
  const where = cwdLabel.trim();
  if (ended) return where ? `下一句会带到 ${where} 的新会话… ↩ 续写,⇧↩ 换行` : '下一句会带到新会话的第一句话… ↩ 续写,⇧↩ 换行';
  return where ? `对 ${where} 说点什么… ↩ 发送,⇧↩ 换行,可拖入文件` : '对这条会话说点什么… ↩ 发送,⇧↩ 换行';
}

/** 点开会话就能写。弹层、抽屉、新会话面板开着时别抢焦点。 */
export function composerShouldFocus(input: {
  hasSession: boolean;
  view: string;
  drawer: string | null | undefined;
  newBoxOpen: boolean;
  paletteOpen: boolean;
  pickerOpen: boolean;
  whatsNewOpen: boolean;
  flowFindOpen?: boolean;
  windowOpOpen?: boolean;
}): boolean {
  return input.hasSession && input.view === 'home' && !input.drawer && !input.newBoxOpen && !input.paletteOpen && !input.pickerOpen && !input.whatsNewOpen && !input.flowFindOpen && !input.windowOpOpen;
}

/** 点选面里的像素 → 窗口内相对坐标。贴边会收进 (0,1),出框不算。 */
export const WINDOW_KEY_BUTTONS = [
  { key: 'return', label: '回车' },
  { key: 'escape', label: 'Esc' },
  { key: 'tab', label: 'Tab' },
  { key: 'space', label: '空格' },
  { key: 'up', label: '↑' },
  { key: 'down', label: '↓' },
  { key: 'left', label: '←' },
  { key: 'right', label: '→' },
  { key: 'delete', label: '删除' },
] as const;

export function clickPointFromElement(clientX: number, clientY: number, rect: { left: number; width: number; top: number; height: number }): { x: number; y: number } | null {
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  const rawX = (clientX - rect.left) / rect.width;
  const rawY = (clientY - rect.top) / rect.height;
  if (!Number.isFinite(rawX) || !Number.isFinite(rawY) || rawX < 0 || rawX > 1 || rawY < 0 || rawY > 1) return null;
  return { x: Math.min(0.999, Math.max(0.001, rawX)), y: Math.min(0.999, Math.max(0.001, rawY)) };
}

export function scrollDeltaFromWheel(deltaX: number, deltaY: number): { dx?: number; dy?: number } | null {
  const tick = (delta: number) => {
    if (!Number.isFinite(delta) || delta === 0) return 0;
    const mag = Math.min(8, Math.max(1, Math.round(Math.abs(delta) / 40)));
    return delta > 0 ? mag : -mag;
  };
  const dx = tick(deltaX);
  const dy = tick(deltaY);
  if (!dx && !dy) return null;
  return { ...(dx ? { dx } : {}), ...(dy ? { dy } : {}) };
}

export function windowPadGesture(start: { x: number; y: number }, end: { x: number; y: number }):
  | { kind: 'click'; point: { x: number; y: number } }
  | { kind: 'drag'; from: { x: number; y: number }; to: { x: number; y: number } } {
  return Math.hypot(end.x - start.x, end.y - start.y) >= 0.04
    ? { kind: 'drag', from: start, to: end }
    : { kind: 'click', point: start };
}

export function windowMenuLabel(path: string[]): string {
  return path.map((item) => item.trim()).filter(Boolean).join(' · ');
}

export function mentionWindowRead(draft: string, text: string): string {
  const body = text.replace(/\s+$/, '');
  if (!body) return draft;
  const current = draft.replace(/\s+$/, '');
  if (!current) return body;
  if (current.includes(body)) return current;
  return `${current}\n${body}`;
}

export function usableWindowMenus(menus: Array<{ path?: string[]; enabled?: boolean }> | undefined, limit = 24): Array<{ path: string[] }> {
  const seen = new Set<string>();
  const out: Array<{ path: string[] }> = [];
  for (const row of menus ?? []) {
    if (row.enabled === false) continue;
    const path = (row.path ?? []).map((item) => item.trim()).filter((item) => item.length > 0 && item.length <= 160);
    if (path.length < 2 || path.length > 6) continue;
    const key = path.join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path });
    if (out.length >= limit) break;
  }
  return out;
}

export function flowRowMatchesQuery(row: FlowRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const blob = (() => {
    switch (row.k) {
      case 'user':
      case 'ai':
      case 'think':
      case 'sys':
        return row.text;
      case 'tool':
        return `${row.tool} ${row.preview} ${row.output}`;
      case 'edit':
        return `${row.file} ${row.tool}`;
      case 'ap':
        return `${row.title} ${row.command} ${row.tool}`;
      default:
        return '';
    }
  })();
  return blob.toLowerCase().includes(q);
}

export function flowFindHits(rows: FlowRow[], query: string): number {
  return flowFindHitKeys(rows, query).length;
}

export function flowFindHitKeys(rows: FlowRow[], query: string): string[] {
  const q = query.trim();
  if (!q) return [];
  return rows.filter((row) => flowRowMatchesQuery(row, q)).map((row) => row.key);
}

export function nextFlowFindIndex(hits: number, current: number, dir: 1 | -1): number {
  if (hits <= 0) return -1;
  if (current < 0 || current >= hits) return dir === 1 ? 0 : hits - 1;
  return (current + dir + hits) % hits;
}

export function flowFindStatus(hits: number, index: number): string {
  if (hits <= 0) return '0 条';
  const n = index >= 0 && index < hits ? index + 1 : 1;
  return `${n} / ${hits}`;
}

export function flowFindEmptyHint(): string {
  return '回车 · ↑↓';
}

export function flowFindActLabel(kind: 'prev' | 'next' | 'copy' | 'close'): string {
  return { prev: '上', next: '下', copy: '复制', close: '关' }[kind];
}

export function flowFindHitText(row: FlowRow | undefined): string {
  if (!row) return '';
  switch (row.k) {
    case 'user':
    case 'ai':
    case 'think':
    case 'sys':
      return row.text;
    case 'tool':
      return row.preview || row.output || row.tool;
    case 'edit':
      return row.file;
    case 'ap':
      return row.command || row.title;
    default:
      return '';
  }
}

export function highlightQueryParts(text: string, query: string): Array<{ t: string; hit: boolean }> {
  const src = text ?? '';
  const q = query.trim();
  if (!src) return [];
  if (!q) return [{ t: src, hit: false }];
  const lower = src.toLowerCase();
  const needle = q.toLowerCase();
  const out: Array<{ t: string; hit: boolean }> = [];
  let i = 0;
  while (i < src.length) {
    const at = lower.indexOf(needle, i);
    if (at < 0) {
      out.push({ t: src.slice(i), hit: false });
      break;
    }
    if (at > i) out.push({ t: src.slice(i, at), hit: false });
    out.push({ t: src.slice(at, at + needle.length), hit: true });
    i = at + needle.length;
  }
  return out;
}

export type UserTurnMode = 'prompt' | 'steer' | 'follow_up';

export function userTurnMode(event: { mode?: unknown; steer?: unknown }): UserTurnMode {
  if (event.mode === 'steer' || event.steer === true) return 'steer';
  if (event.mode === 'follow_up') return 'follow_up';
  return 'prompt';
}

export function userTurnLabel(mode: UserTurnMode): string {
  if (mode === 'steer') return '插话';
  if (mode === 'follow_up') return '接着';
  return '你';
}

let rowSeq = 0;
const nextKey = () => `r${++rowSeq}`;

function closeStreaming(rows: FlowRow[]): FlowRow[] {
  const last = rows[rows.length - 1];
  if (last && (last.k === 'ai' || last.k === 'think') && last.streaming) return [...rows.slice(0, -1), { ...last, streaming: false }];
  return rows;
}

function isEditTool(tool: string): boolean {
  return tool === 'edit' || tool === 'write';
}

/** 纯函数:一条事件进来,返回新的视图。不认识的事件原样忽略,永远不抛。 */
export function applyEvent(view: SessionView, event: HarnessEvent): SessionView {
  const name = event.event;
  if (typeof event.seq === 'number' && event.seq > 0 && event.seq <= view.seq) return view;
  const seq = typeof event.seq === 'number' ? event.seq : view.seq;
  let rows = view.rows;
  let { status, policy, model, thinking, title, window: bound } = view;
  const pendingApprovals = new Map(view.pendingApprovals);

  switch (name) {
    case 'session.created':
      model = typeof event.model === 'string' ? event.model : model;
      policy = typeof event.policy === 'string' ? event.policy : policy;
      break;
    case 'user.message': {
      const text = str(event.text);
      const mode = userTurnMode(event);
      if (!title && mode === 'prompt') title = text.replace(/\s+/g, ' ').trim().slice(0, 80);
      rows = [...closeStreaming(rows), { k: 'user', key: nextKey(), text, mode }];
      status = 'running';
      break;
    }
    case 'message.delta': {
      const delta = str(event.delta);
      const last = rows[rows.length - 1];
      if (last && last.k === 'ai' && last.streaming) rows = [...rows.slice(0, -1), { ...last, text: last.text + delta }];
      else rows = [...closeStreaming(rows), { k: 'ai', key: nextKey(), text: delta, streaming: true }];
      break;
    }
    case 'reasoning.available': {
      const delta = str(event.text ?? event.delta);
      if (!delta) break;
      const last = rows[rows.length - 1];
      if (last && last.k === 'think' && last.streaming) rows = [...rows.slice(0, -1), { ...last, text: last.text + delta }];
      else rows = [...closeStreaming(rows), { k: 'think', key: nextKey(), text: delta, streaming: true }];
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
    case 'harness.translate_error': {
      const text = humanizeError(str(event.text ?? event.error));
      rows = [...closeStreaming(rows), { k: 'sys', key: nextKey(), text: `内核翻译出错:${text}`, tone: 'error' }];
      break;
    }
    case 'run.cancelled':
      rows = [...closeStreaming(rows), { k: 'sys', key: nextKey(), text: '已停止。进程不在了,可以在同一目录开一条新的接着干。', tone: 'muted' }];
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
        rows = [...rows, { k: 'sys', key: nextKey(), text: `已切换到 ${prettyModelName(next)} · 同一条会话继续,上下文不变`, tone: 'muted' }];
      }
      break;
    }
    case 'session.compacted':
      rows = [...rows, { k: 'sys', key: nextKey(), text: '已压缩:早先的轮次折成一条摘要,上下文变轻了', tone: 'muted' }];
      break;
    case 'window.bound': {
      const next = boundWindowFromUnknown(event);
      if (next) {
        bound = next;
        const label = windowBoundLabel(next);
        if (label) rows = [...rows, { k: 'sys', key: nextKey(), text: `已记住前台窗口:${label}`, tone: 'muted' }];
      }
      break;
    }
    case 'session.thinking': {
      thinking = str(event.level) || thinking;
      rows = [...rows, { k: 'sys', key: nextKey(), text: `思考深度改为「${THINKING_LABEL[thinking] ?? thinking}」`, tone: 'muted' }];
      break;
    }
    default:
      break;
  }
  return { rows, seq: Math.max(view.seq, seq), status, policy, model, thinking, title, window: bound, pendingApprovals };
}

export function modelLabel(model: string | null | undefined): string {
  if (!model) return '默认模型';
  const slash = model.indexOf('/');
  return slash > 0 ? model.slice(slash + 1) : model;
}

/** 会话头 / 选择器里用的短名。认得出的写成产品名,认不出就用供应商给的 name 或原始 id。 */
const PRETTY_MODELS: Record<string, string> = {
  'claude-fable-5-1': 'Claude Fable 5.1', 'claude-fable-5': 'Claude Fable 5',
  'claude-opus-5': 'Claude Opus 5', 'claude-opus-4-8': 'Claude Opus 4.8', 'claude-opus-4-7': 'Claude Opus 4.7',
  'claude-opus-4-6': 'Claude Opus 4.6', 'claude-opus-4-5': 'Claude Opus 4.5',
  'claude-sonnet-5': 'Claude Sonnet 5', 'claude-sonnet-4-6': 'Claude Sonnet 4.6', 'claude-sonnet-4-5': 'Claude Sonnet 4.5',
  'claude-haiku-4-5': 'Claude Haiku 4.5',
  'gpt-6-astra': 'GPT-6 Astra', 'gpt-5.6-sol': 'GPT-5.6 Sol', 'gpt-5.6-terra': 'GPT-5.6 Terra', 'gpt-5.6-luna': 'GPT-5.6 Luna',
  'gpt-5.5-pro': 'GPT-5.5 Pro', 'gpt-5.5': 'GPT-5.5', 'gpt-5.4-pro': 'GPT-5.4 Pro', 'gpt-5.4-mini': 'GPT-5.4 mini', 'gpt-5.4': 'GPT-5.4',
  'gpt-5.3-codex': 'GPT-5.3 Codex', 'gpt-5-codex': 'GPT-5 Codex', 'gpt-5-mini': 'GPT-5 mini', 'gpt-5': 'GPT-5',
  'grok-4.6': 'Grok 4.6', 'grok-4.5': 'Grok 4.5', 'grok-4.3': 'Grok 4.3',
  'gemini-3.8-flash': 'Gemini 3.8 Flash', 'gemini-3.7-flash': 'Gemini 3.7 Flash', 'gemini-3.6-flash': 'Gemini 3.6 Flash',
  'gemini-3.5-flash': 'Gemini 3.5 Flash', 'gemini-3.1-pro-preview': 'Gemini 3.1 Pro', 'gemini-3-pro': 'Gemini 3 Pro',
  'glm-5.3': 'GLM-5.3', 'glm-5.2': 'GLM-5.2', 'glm-4.6': 'GLM-4.6', 'kimi-k3': 'Kimi K3', 'kimi-k2.7-code': 'Kimi K2.7 Code',
  'deepseek-v4-pro': 'DeepSeek V4 Pro', 'deepseek-v4-flash': 'DeepSeek V4 Flash', 'deepseek-v4': 'DeepSeek V4',
  'grok-code': 'Grok Code', 'qwen3-coder': 'Qwen3 Coder', 'claude-3-7-sonnet': 'Claude 3.7 Sonnet',
  'claude-3-5-sonnet': 'Claude 3.5 Sonnet', 'gemini-2.5-pro': 'Gemini 2.5 Pro', 'gemini-2.5-flash': 'Gemini 2.5 Flash',
};

export function prettifyUnknownModel(id: string): string {
  return id
    .replace(/[-_]+/g, ' ')
    .replace(/\b([a-z])/g, (ch) => ch.toUpperCase())
    .replace(/\bGpt\b/g, 'GPT')
    .replace(/\bGlm\b/g, 'GLM')
    .replace(/\bGrok\b/g, 'Grok');
}

export function prettyModelName(model: string | null | undefined, fallbackName?: string): string {
  const id = modelLabel(model);
  if (id === '默认模型') return fallbackName || id;
  if (PRETTY_MODELS[id]) return PRETTY_MODELS[id];
  if (fallbackName && fallbackName !== id) return fallbackName;
  return prettifyUnknownModel(id);
}

export function providerOf(model: string | null | undefined): string {
  if (!model) return '';
  const slash = model.indexOf('/');
  return slash > 0 ? model.slice(0, slash) : '';
}

export type StatusDot = 'need' | 'run' | 'err' | 'off' | 'idle';

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
  if (summary.status === 'orphaned') return '上次运行留下的记录';
  if (summary.status === 'completed') return '已完成';
  if (summary.status === 'cancelled') return '已停止';
  if (summary.status === 'waiting_for_approval') {
    const first = summary.pending_approvals?.[0];
    return `需要确认:${(first?.command ?? summary.last_event?.text ?? '').split('\n')[0]}`;
  }
  const ev = summary.last_event;
  if (!ev) return summary.status === 'orphaned' ? '上次运行留下的记录' : '';
  switch (ev.event) {
    case 'user.message': {
      const who = ev.mode === 'steer' ? '插话' : ev.mode === 'follow_up' ? '接着' : '你';
      return `${who}:${ev.text}`;
    }
    case 'tool.started': return `正在运行 ${ev.text}`;
    case 'reasoning.available': return '正在想…';
    case 'message.delta': return ev.text;
    case 'approval.request': return `需要确认:${ev.text.split('\n')[0]}`;
    case 'run.completed': return '已完成';
    case 'run.failed': return `失败 · ${humanizeError(ev.text)}`;
    case 'run.cancelled': return '已停止';
    default: return ev.text;
  }
}

/** pi 的报错是给终端用户看的英文 + 文件路径;这里翻成一句能行动的话。 */
export function humanizeError(raw: string): string {
  const text = (raw || '').trim();
  if (!text) return '未知错误';
  if (/session is not running/i.test(text)) return '这条会话的进程已经不在了 —— 用「在同一目录续写」接着干';
  if (/session is still running/i.test(text)) return '先停止这条会话,再从左栏拿掉';
  if (/one-shot|start a new task/i.test(text)) return '这类会话发完就结束,要继续请开一条新的';
  if (/还没有登录任何模型/.test(text)) return '还没有登录任何模型 —— 先到「设置」授权或填密钥';
  if (/no api key/i.test(text)) return '这个模型还没有登录或密钥 —— 到「设置」登录一个供应商后再试';
  if (/already processing|streamingBehavior/i.test(text)) {
    return '模型还在跑。现在发出去的应是插话,会插进当前这一轮';
  }
  if (/not supported when using Codex with a ChatGPT account/i.test(text)) {
    return '当前 ChatGPT 登录用不了这个模型 —— 换一个再试';
  }
  if (/not supported when using Codex/i.test(text)) return '当前登录用不了这个模型 —— 换一个再试';
  if (/unknown (model|provider)/i.test(text)) return '这个模型不可用 —— 到「设置」里选一个已登录的模型';
  if (/rate limit|too many requests|429/.test(text)) return '模型限流了,过一会儿再试,或换一个模型';
  if (/context (length|window)|too many tokens|maximum context/i.test(text)) return '上下文太长了 —— 用「压缩这条会话」后再继续';
  if (/401|unauthorized|invalid api key|incorrect api key/i.test(text)) return '密钥无效或已过期 —— 到「设置」更换';
  if (/timeout|ETIMEDOUT|timed out/i.test(text)) return '请求超时,等一会儿再试';
  if (/\b502\b|\b503\b|bad gateway|service unavailable/i.test(text)) return '模型服务暂时不可用,过一会儿再试';
  if (/relay 404/i.test(text)) return '对面这台还没有文件产物接口,只能看到会话改过的文件名';
  if (/relay|not reachable|machine offline|unreachable/i.test(text)) return '那台机器现在连不上,等它上线或到「设备」看状态';
  if (/ECONNREFUSED|ENOTFOUND|fetch failed|network/i.test(text)) return '连不上模型接口,检查网络或设置里的地址';
  if (/exited with code/i.test(text)) return `内核进程退出(${text})`;
  return text.split('\n')[0].replace(/\s+See:.*$/i, '').slice(0, 200);
}

export type Group = { id: string; name: string; role: '本机' | '被控'; online: boolean; stale?: boolean; sessions: SessionSummary[] };

export function isLiveRow(row: FlowRow): boolean {
  if (row.k === 'ai' || row.k === 'think') return row.streaming;
  if (row.k === 'tool' || row.k === 'edit') return row.running;
  return row.k === 'ap';
}

export function nextProbeHealth(fails: number, ok: boolean, staleAfter = 2): { fails: number; stale: boolean } {
  if (ok) return { fails: 0, stale: false };
  const next = fails + 1;
  return { fails: next, stale: next >= staleAfter };
}

export function endedSessionHint(status: string): string {
  if (status === 'orphaned') return '这是上次留下的记录,进程已不在。可以在同一目录开一条新的接着干。';
  if (status === 'failed') return '这条会话失败了。可以在同一目录开一条新的接着干。';
  return '这条会话已经结束。可以在同一目录开一条新的接着干。';
}

export function endedComposerLead(status: string): string {
  return endedSessionHint(status).split('。')[0] || '已结束';
}

export function continueSessionDraft(input: { machine?: string | null; cwd?: string | null; prompt?: string | null; model?: string | null }): { open: true; machine: string; cwd?: string; prompt?: string; model?: string } {
  const next: { open: true; machine: string; cwd?: string; prompt?: string; model?: string } = { open: true, machine: input.machine || 'local' };
  const cwd = input.cwd?.trim();
  const prompt = input.prompt?.trim();
  const model = input.model?.trim();
  if (cwd) next.cwd = cwd;
  if (prompt) next.prompt = prompt;
  if (model && !modelLikelyUnusable(model)) next.model = model;
  return next;
}

export function composerShouldSend(event: { key: string; shiftKey: boolean; nativeEvent?: { isComposing?: boolean }; keyCode?: number }): boolean {
  if (event.key !== 'Enter' || event.shiftKey) return false;
  if (event.nativeEvent?.isComposing || event.keyCode === 229) return false;
  return true;
}

export function nextUnseen(prev: number, grew: boolean, stick: boolean): number {
  if (stick) return 0;
  return grew ? prev + 1 : prev;
}

export const LAST_MODEL_KEY = 'leo2.lastModel';
export const LAST_CWD_KEY = 'leo2.lastCwd';

export function nextFocusIndex(len: number, current: number, shift: boolean): number {
  if (len <= 0) return -1;
  if (shift) return current <= 0 ? len - 1 : current - 1;
  return current < 0 || current >= len - 1 ? 0 : current + 1;
}

export function pickInitialCwd(defaultCwd: string, remembered: string): string {
  const current = defaultCwd.trim();
  if (current && current !== '~') return current;
  const last = remembered.trim();
  return last || current || '~';
}

export function pickInitialModel(models: Array<{ provider: string; id: string }>, remembered: string): string {
  const key = remembered.trim();
  const rememberedModel = models.find((model) => `${model.provider}/${model.id}` === key);
  if (rememberedModel && !chatgptCodexLikelyRejected(rememberedModel)) return key;
  if (key && !rememberedModel) return key;
  const preferred = models.find((model) => !chatgptCodexLikelyRejected(model)) ?? models[0];
  return preferred ? `${preferred.provider}/${preferred.id}` : '';
}

/** ChatGPT 订阅登录的 Codex:目录会列出账号跑不通的 id。已实测 spark / GPT-5.4* 被拒,GPT-5.5 能回。 */
function chatgptCodexLikelyRejected(model: { provider: string; id: string }): boolean {
  return model.provider === 'openai-codex' && /spark|gpt-5\.4/i.test(model.id);
}

export function modelIdOf(model: string | null | undefined): string {
  const key = (model || '').trim();
  const slash = key.lastIndexOf('/');
  return slash >= 0 ? key.slice(slash + 1) : key;
}

export function modelLikelyUnusable(model: { provider: string; id: string } | string | null | undefined): boolean {
  if (model == null || model === '') return false;
  if (typeof model === 'string') {
    const slash = model.indexOf('/');
    if (slash <= 0) return false;
    return chatgptCodexLikelyRejected({ provider: model.slice(0, slash), id: model.slice(slash + 1) });
  }
  return chatgptCodexLikelyRejected(model);
}

export function rejectedCodexModelId(text: string): string | null {
  const match = text.match(/'([^']+)' model is not supported when using Codex with a ChatGPT account/i);
  return match?.[1] ?? null;
}

/** 条上的失败字和发送闸门用同一批:摘要最后一行 + 流水里的系统行。 */
export function sessionFailTexts(input: {
  lastEventText?: string | null;
  rows?: readonly { k: string; text?: string }[];
}): string[] {
  const sys = (input.rows ?? [])
    .filter((row): row is { k: 'sys'; text: string } => row.k === 'sys' && typeof row.text === 'string')
    .map((row) => row.text);
  return [input.lastEventText ?? '', ...sys];
}

/** 这条会话已经用当前模型被 ChatGPT 账号拒过:还能换模型接着干,不要再用同一个 id 发。 */
export function composerNeedsModelSwitch(model: string | null | undefined, texts: readonly string[]): boolean {
  const id = modelIdOf(model);
  if (!id) return false;
  return texts.some((text) => rejectedCodexModelId(text) === id);
}

export function modelChoiceHint(model: { provider: string; id: string }): string {
  return modelLikelyUnusable(model) ? '当前 ChatGPT 登录可能用不了' : '';
}

/** 选择器先排能用的,ChatGPT 账号大概率拒的 spark / 5.4 沉底,不要一打开就对着它们。 */
export function rankModelsForPicker<T>(models: readonly T[], unusable: (model: T) => boolean): T[] {
  const ready: T[] = [];
  const later: T[] = [];
  for (const model of models) (unusable(model) ? later : ready).push(model);
  return ready.concat(later);
}

export function statusDotForSession(session: { status: string; last_event?: { event?: string } | null }): StatusDot {
  if (sessionLooksFailed(session)) return 'err';
  return statusDot(session.status);
}

const TERMINAL = new Set(['completed', 'cancelled', 'orphaned', 'failed']);

export function sessionCanForget(status: string): boolean {
  return TERMINAL.has(status);
}

export const HIDDEN_SESSIONS_KEY = 'leo2.hiddenSessions';

export function sessionKey(machine: string, id: string): string {
  return `${machine}:${id}`;
}

export function readHiddenSessionKeys(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && item.includes(':')) : [];
  } catch {
    return [];
  }
}

export function addHiddenSessionKey(hidden: readonly string[], key: string): string[] {
  return hidden.includes(key) ? [...hidden] : [...hidden, key];
}

export function sessionCanDrive(summaryStatus: string, viewStatus: string): boolean {
  if (TERMINAL.has(summaryStatus)) return false;
  return isLiveStatus(summaryStatus) || isLiveStatus(viewStatus);
}

/** 终态会话的事件流会正常结束,不要再标「重连中」或自动重连。 */
export function shouldReconnectSessionStream(status: string | null | undefined): boolean {
  if (!status) return true;
  return !TERMINAL.has(status);
}

export function isLiveStatus(status: string): boolean {
  return status === 'running' || status === 'starting' || status === 'waiting_for_approval' || status === 'idle';
}

export function keepActiveSession<T extends { session_id: string }>(
  sessions: T[],
  matches: (session: T) => boolean,
  activeId?: string | null,
): T[] {
  return sessions.filter((session) => matches(session) || (activeId != null && session.session_id === activeId));
}

const HISTORY_STATUSES = new Set(['orphaned', 'completed', 'cancelled']);

export function isHistoryStatus(status: string): boolean {
  return HISTORY_STATUSES.has(status);
}

export function sessionLooksFailed(session: { status: string; last_event?: { event?: string } | null }): boolean {
  return session.status === 'failed' || session.last_event?.event === 'run.failed';
}

export type SessionFilter = 'all' | 'active' | 'need' | 'err' | 'history';

export function sessionMatchesFilter(session: { status: string; last_event?: { event?: string } | null }, filter: SessionFilter): boolean {
  switch (filter) {
    case 'all': return !isHistoryStatus(session.status);
    case 'active': return session.status === 'running' || session.status === 'starting' || session.status === 'waiting_for_approval';
    case 'need': return session.status === 'waiting_for_approval';
    case 'err': return sessionLooksFailed(session);
    case 'history': return isHistoryStatus(session.status);
    default: return true;
  }
}

export function countFilteredSessions<T extends { session_id: string; status: string; last_event?: { event?: string } | null }>(
  sessions: T[],
  filter: SessionFilter,
  activeId?: string | null,
): number {
  // 「全部」要跟左栏对上:正在看的历史行也算。其它筛选项按类别本身计,不能因为你点开一条死会话就冒充「进行中」。
  if (filter === 'all') return keepActiveSession(sessions, (session) => sessionMatchesFilter(session, filter), activeId).length;
  return sessions.filter((session) => sessionMatchesFilter(session, filter)).length;
}

/** 「全部」不列历史。正在看的那条历史已经在栏里时,提示里不要再数它一次。 */
export function hiddenHistoryHint(filter: string, historyCount: number, showingActiveHistory: boolean): string {
  if (filter !== 'all' || historyCount <= 0) return '';
  const extra = showingActiveHistory ? historyCount - 1 : historyCount;
  if (extra <= 0) return '';
  return `还有 ${extra} 条历史`;
}

export function sessionMatchesQuery(session: { title?: string | null; cwd?: string | null; model?: string | null }, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [session.title || '新会话', session.cwd || '', session.model || ''].join('\n').toLowerCase().includes(q);
}

export function machineNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\.local$/, '');
}

export function isSameMachineName(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return machineNameKey(a) === machineNameKey(b);
}

/** 本机和中继报的是同一台时,只留一组;中继多出来的会话并进来,不丢掉。 */
export function mergeSameMachineSessions<T extends { session_id: string }>(primary: T[], extra: T[]): T[] {
  const seen = new Set(primary.map((session) => session.session_id));
  const out = [...primary];
  for (const session of extra) {
    if (seen.has(session.session_id)) continue;
    seen.add(session.session_id);
    out.push(session);
  }
  return out;
}

export function sessionNeedsSettings(texts: readonly string[]): boolean {
  return texts.some((text) => /no api key|unauthorized|invalid api key|unknown (model|provider)|还没有登录|密钥无效|到「设置」|这个模型不可用/i.test(text));
}

export function localCreateNeedsSettings(modelCount: number): boolean {
  return modelCount <= 0;
}

export function homeEmptyCopy(input: { loadError?: string | null; modelCount: number; providersReady?: boolean }): { title: string; hint: string; action: 'retry' | 'settings' | 'none' } {
  if (input.loadError) return { title: '连不上本机服务', hint: humanizeError(input.loadError), action: 'retry' };
  if (input.providersReady === false) {
    return { title: '正在读取可用模型', hint: '已经登录过的供应商会从接口把模型拉回来。', action: 'none' };
  }
  if (localCreateNeedsSettings(input.modelCount)) {
    return { title: '还没有可用模型', hint: '登录一个供应商或填密钥之后,才能在这台 Mac 上开会话。', action: 'settings' };
  }
  return { title: '还没有会话', hint: '⌘N 新建一条,或在左栏选一条继续', action: 'none' };
}

export function settingsNeededCopy(): { title: string; hint: string } {
  return { title: '这个模型还不能用', hint: '到设置里登录或填密钥。回来之后可以在同一目录续写。' };
}

export function nextSessionIndex(len: number, current: number, dir: 1 | -1): number {
  if (len <= 0) return -1;
  if (current < 0) return dir > 0 ? 0 : len - 1;
  return Math.max(0, Math.min(len - 1, current + dir));
}

export const STATUS_LABEL: Record<string, string> = {
  running: '进行中', starting: '启动中', waiting_for_approval: '需要你', idle: '空闲,可以接着说',
  completed: '已完成', failed: '失败', cancelled: '已停止', orphaned: '已失联',
};

export type MarkupPart = { k: 'text' | 'code' | 'strong'; v: string };

/** 流水里的轻标记:行内代码与加粗。不做完整 Markdown,避免把 IDE 那套渲染拉进 2.0 壳。 */
export function markupParts(text: string): MarkupPart[] {
  const parts: MarkupPart[] = [];
  const src = text ?? '';
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(src))) {
    if (match.index > last) parts.push({ k: 'text', v: src.slice(last, match.index) });
    const token = match[0];
    if (token.startsWith('`')) parts.push({ k: 'code', v: token.slice(1, -1) });
    else parts.push({ k: 'strong', v: token.slice(2, -2) });
    last = match.index + token.length;
  }
  if (last < src.length) parts.push({ k: 'text', v: src.slice(last) });
  return parts.length > 0 ? parts : [{ k: 'text', v: src }];
}

export function formatContextWindow(tokens: number | null | undefined): string {
  if (!tokens || tokens <= 0) return '';
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    const rounded = Math.round(millions);
    return `${Math.abs(millions - rounded) < 0.08 ? rounded : millions.toFixed(1)}M`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}
