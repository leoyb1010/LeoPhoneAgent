import type { HarnessSession } from './harness-session.service.js';
import type { HarnessEvent } from './harness-dialects.js';

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

export function buildDigest(session: HarnessSession): HarnessDigest {
  const events: HarnessEvent[] = session.replay(0);

  const prompts: string[] = [];
  const tools: ToolRecord[] = [];
  const files = new Set<string>();
  const approvals = new Map<string, ApprovalRecord>();
  let lastMessage = '';
  let messageBuffer = '';
  let error: string | null = null;
  let toolErrors = 0;

  for (const event of events) {
    switch (event.event) {
      case 'user.message': {
        const t = text(event.text, PROMPT_CHARS);
        if (t) prompts.push(t);
        // 新一轮开始,上一轮的成文回复定稿
        if (messageBuffer.trim()) {
          lastMessage = messageBuffer;
          messageBuffer = '';
        }
        break;
      }
      case 'message.delta': {
        const delta = typeof event.delta === 'string' ? event.delta : '';
        messageBuffer += delta;
        break;
      }
      case 'tool.started': {
        const preview = text(event.preview, 200);
        tools.push({ tool: String(event.tool ?? 'tool'), preview, ok: true });
        for (const p of extractPaths(preview)) files.add(p);
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
  }

  if (messageBuffer.trim()) lastMessage = messageBuffer;

  const base = session.summary() as Record<string, unknown>;
  const approvalList = [...approvals.values()];

  return {
    session_id: String(base.session_id ?? ''),
    harness: String(base.harness ?? ''),
    cwd: String(base.cwd ?? ''),
    status: String(base.status ?? 'unknown'),
    seq: Number(base.seq ?? 0),
    prompts: prompts.slice(-MAX_LIST),
    tools: tools.slice(-MAX_LIST),
    files: [...files].slice(0, MAX_LIST),
    approvals: approvalList.slice(-MAX_LIST),
    last_message: text(lastMessage, MESSAGE_CHARS),
    error,
    counts: {
      events: events.length,
      prompts: prompts.length,
      tools: tools.length,
      tool_errors: toolErrors,
      approvals: approvalList.length,
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

export function buildReceipt(session: HarnessSession): HarnessReceipt {
  const digest = buildDigest(session);
  const approved = digest.approvals.filter(
    (a) => a.choice === 'once' || a.choice === 'always' || a.choice === 'approve',
  ).length;
  return {
    ...digest,
    object: 'leoagent.receipt',
    outcome: digest.status,
    approved_count: approved,
    denied_count: digest.approvals.filter((a) => a.resolved).length - approved,
  };
}
