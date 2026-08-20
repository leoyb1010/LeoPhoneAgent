export type RemoteLogLine = { seq: number; text: string; tone: 'info' | 'warn' | 'approval' };

export type PendingApproval = { approvalId: string; command: string; choices: string[] };

/**
 * 会话终态。服务端(harness-session.service.ts 的 subscribe)一到终态就 return,
 * 路由随即 res.end() —— 也就是说**每次远程任务正常跑完**,这条 SSE 都会正常关闭。
 * 客户端必须能把「正常收尾」和「链路断了」分开,否则每跑完一个任务都会当成
 * 断线去重连,而重连上来的会话已是终态、回放完立刻又被关流,变成永久 2 秒一轮的
 * 重连风暴 + 一屏红字。
 */
export function isTerminalRemoteEvent(frame: Record<string, unknown>): boolean {
  return ['run.completed', 'run.failed', 'run.cancelled'].includes(String(frame.event ?? ''));
}

/** 按 approval_id 维护待批队列:并发两条时答一条不能把另一条卡片清掉。 */
export function applyApprovalFrame(
  pending: PendingApproval[],
  frame: Record<string, unknown>,
): PendingApproval[] {
  const type = String(frame.event ?? '');
  const approvalId = String(frame.approval_id ?? frame.approvalId ?? '');
  if (type === 'approval.request') {
    if (!approvalId) return pending;
    const next = pending.filter((item) => item.approvalId !== approvalId);
    next.push({
      approvalId,
      command: String(frame.command ?? ''),
      choices: Array.isArray(frame.choices) ? frame.choices.map(String) : ['once', 'always', 'deny'],
    });
    return next;
  }
  if (type === 'approval.responded' && approvalId) {
    return pending.filter((item) => item.approvalId !== approvalId);
  }
  return pending;
}

export function describeRemoteEvent(frame: Record<string, unknown>): RemoteLogLine | null {
  const seq = Number(frame.seq ?? 0);
  const type = String(frame.event ?? '');
  if (type === 'tool.started' || type === 'tool.completed') {
    const name = String(frame.name ?? frame.tool ?? 'tool');
    const args = typeof frame.preview === 'string' ? frame.preview : (typeof frame.args === 'string' ? frame.args : '');
    return { seq, text: `✓ ${name}${args ? ` · ${args}` : ''}`, tone: 'info' };
  }
  if (type === 'message.delta' || type === 'message.completed') {
    const text = String(frame.delta ?? frame.text ?? frame.content ?? '').trim();
    return text ? { seq, text, tone: 'info' } : null;
  }
  if (type === 'user.message') {
    const text = String(frame.text ?? '').trim();
    return text ? { seq, text: `› ${text}`, tone: 'info' } : null;
  }
  if (type === 'approval.request') {
    return { seq, text: `⏸ ${String(frame.command ?? '等待审批')}`, tone: 'approval' };
  }
  if (type === 'run.completed') return { seq, text: '■ 运行结束', tone: 'warn' };
  if (type === 'run.failed') return { seq, text: `■ 运行失败 · ${String(frame.message ?? frame.error ?? '')}`, tone: 'warn' };
  return { seq, text: `· ${type || JSON.stringify(frame).slice(0, 160)}`, tone: 'info' };
}

export async function readRemoteSse(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: Record<string, unknown>) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const chunks = buffer.split(/\r?\n\r?\n/);
    buffer = chunks.pop() || '';
    for (const chunk of chunks) {
      const data = chunk.split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      try {
        onFrame(JSON.parse(data) as Record<string, unknown>);
      } catch {
        // An invalid remote frame must not kill the authenticated stream.
      }
    }
    if (done) break;
  }
}
