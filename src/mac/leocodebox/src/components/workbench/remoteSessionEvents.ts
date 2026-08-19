export type RemoteLogLine = { seq: number; text: string; tone: 'info' | 'warn' | 'approval' };

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
