import type { HarnessSession } from './harness-session.service.js';
import type { JournalHealth } from './harness-journal.js';

/**
 * [T-leophone-digest] 会话摘要与任务收据。
 *
 * 手机端接管一个跑了半天的会话时,以前只能从 seq 0 全量回放 NDJSON——
 * 一个长会话上千条事件,冷启动既慢又没有"到底发生了什么"的概览。
 * digest 把日志折叠成结构化视图:当前状态、干过哪些活、动过哪些文件、
 * 谁批了什么、最后说了什么、seq 水位。手机先拉 digest 再从水位增量跟随。
 *
 * receipt 是 digest 的终态快照:会话结束后回答"我批的那条到底跑了没、
 * 结果如何",可离线核对,不必翻转录。
 *
 * 字段一律 snake_case,与 summary() / 手机端契约保持一致。
 */

export type ToolRecord = {
  tool: string;
  preview: string;
  ok: boolean;
};

export type ApprovalRecord = {
  approval_id: string;
  command: string;
  choice: string | null;
  resolved: boolean;
};

export type HarnessDigest = {
  session_id: string;
  harness: string;
  cwd: string;
  status: string;
  seq: number;
  journal: JournalHealth;
  /** 用户发过的指令(截断),让人一眼看出这个会话在干嘛 */
  prompts: string[];
  /** 执行过的工具调用 */
  tools: ToolRecord[];
  /** 提到过的文件路径(从工具预览里粗提,用于"动了哪些文件") */
  files: string[];
  approvals: ApprovalRecord[];
  /** 助手最后一段成文回复(截断) */
  last_message: string;
  /** 出错时的原因 */
  error: string | null;
  counts: {
    events: number;
    prompts: number;
    tools: number;
    tool_errors: number;
    approvals: number;
    approved: number;
    resolved: number;
  };
};

const MAX_LIST = 40;
const PROMPT_CHARS = 200;
const MESSAGE_CHARS = 800;

function text(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

/** 从工具预览里粗提文件路径。宁可少提,不要提出一堆噪音。 */
function extractPaths(preview: string): string[] {
  if (!preview) return [];
  const matches = preview.match(/(?:[\w.~-]*\/)+[\w.-]+\.[A-Za-z0-9]{1,8}/g);
  return matches ? matches.slice(0, 5) : [];
}

export async function buildDigest(session: HarnessSession): Promise<HarnessDigest> {
  await session.flushJournal();
  let eventCount = 0, promptCount = 0, toolCount = 0, approvalCount = 0, approvedCount = 0, resolvedCount = 0, highest = 0;

  const prompts: string[] = [];
  const tools: ToolRecord[] = [];
  const files = new Set<string>();
  const approvals = new Map<string, ApprovalRecord>();
  let lastMessage = '';
  let messageBuffer = '';
  let error: string | null = null;
  let toolErrors = 0;

  for await (const event of session.replay(0)) {
    eventCount++; highest = Number(event.seq);
    switch (event.event) {
      case 'user.message': {
        const t = text(event.text, PROMPT_CHARS);
        if (t) { prompts.push(t); promptCount++; if (prompts.length > MAX_LIST) prompts.shift(); }
        // 新一轮开始,上一轮的成文回复定稿
        if (messageBuffer.trim()) {
          lastMessage = messageBuffer;
          messageBuffer = '';
        }
        break;
      }
      case 'message.delta': {
        const delta = typeof event.delta === 'string' ? event.delta : '';
        messageBuffer = (messageBuffer + delta).slice(0, MESSAGE_CHARS + 1);
        break;
      }
      case 'tool.started': {
        const preview = text(event.preview, 200);
        toolCount++;
        tools.push({ tool: String(event.tool ?? 'tool'), preview, ok: true });
        if (tools.length > MAX_LIST) tools.shift();
        for (const p of extractPaths(preview)) { if (files.size < MAX_LIST) files.add(p); }
        break;
      }
      case 'tool.completed': {
        const isError = event.error === true;
        if (isError) toolErrors += 1;
        // 回填最近一条同名工具的结果
        for (let i = tools.length - 1; i >= 0; i -= 1) {
          if (tools[i].tool === String(event.tool ?? 'tool')) {
            tools[i].ok = !isError;
            break;
          }
        }
        break;
      }
      case 'approval.request': {
        const id = String(event.approval_id ?? event.request_id ?? '');
        if (id) {
          approvalCount++;
          approvals.set(id, {
            approval_id: id,
            command: text(event.command, 200),
            choice: null,
            resolved: false,
          });
        }
        break;
      }
      case 'approval.responded': {
        const id = String(event.approval_id ?? '');
        const choice = typeof event.choice === 'string' ? event.choice : null;
        if (id) {
          resolvedCount++;
          if (choice === 'once' || choice === 'always' || choice === 'approve') approvedCount++;
        }
        if (id && approvals.has(id)) {
          const record = approvals.get(id)!;
          record.choice = choice;
          record.resolved = true;
        } else if (id) {
          approvals.set(id, { approval_id: id, command: '', choice, resolved: true });
        }
        break;
      }
      case 'run.failed': {
        error = text(event.error ?? event.message, 300) || 'run failed';
        break;
      }
      case 'run.completed': {
        if (messageBuffer.trim()) {
          lastMessage = messageBuffer;
          messageBuffer = '';
        }
        break;
      }
      default:
        break;
    }
    while (approvals.size > MAX_LIST) approvals.delete(approvals.keys().next().value!);
  }

  if (messageBuffer.trim()) lastMessage = messageBuffer;

  const base = session.summary() as Record<string, unknown>;
  const approvalList = [...approvals.values()];

  return {
    session_id: String(base.session_id ?? ''),
    harness: String(base.harness ?? ''),
    cwd: String(base.cwd ?? ''),
    status: String(base.status ?? 'unknown'),
    seq: highest,
    journal: session.journalHealth(),
    prompts: prompts.slice(-MAX_LIST),
    tools: tools.slice(-MAX_LIST),
    files: [...files].slice(0, MAX_LIST),
    approvals: approvalList.slice(-MAX_LIST),
    last_message: text(lastMessage, MESSAGE_CHARS),
    error,
    counts: {
      events: eventCount,
      prompts: promptCount,
      tools: toolCount,
      tool_errors: toolErrors,
      approvals: approvalCount,
      approved: approvedCount,
      resolved: resolvedCount,
    },
  };
}

export type HarnessReceipt = HarnessDigest & {
  object: 'leoagent.receipt';
  /** 终态:completed / failed / cancelled;非终态会话不出收据 */
  outcome: string;
  approved_count: number;
  denied_count: number;
};

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export function isTerminal(status: string): boolean {
  return TERMINAL.has(status);
}

export async function buildReceipt(session: HarnessSession): Promise<HarnessReceipt> {
  if (!isTerminal(session.status)) throw new Error('SESSION_NOT_TERMINAL');
  const health = await session.flushJournal();
  if (health.state !== 'durable' || health.durable_seq < session.seq) throw new Error('JOURNAL_NOT_DURABLE');
  const digest = await buildDigest(session);
  if (digest.journal.state !== 'durable' || digest.seq !== session.seq || !isTerminal(session.status)) {
    throw new Error('JOURNAL_NOT_DURABLE');
  }
  return {
    ...digest,
    object: 'leoagent.receipt',
    outcome: digest.status,
    approved_count: digest.counts.approved,
    denied_count: digest.counts.resolved - digest.counts.approved,
  };
}
