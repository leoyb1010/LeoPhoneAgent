import { useCallback, useEffect, useRef, useState } from 'react';
import { Square, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { apiClient } from '../../utils/apiClient';

export type RemoteTarget = { machine: string; sessionId: string; harness?: string };

type RemoteSessionPanelProps = {
  target: RemoteTarget;
  onClose: () => void;
};

type LogLine = { seq: number; text: string; tone: 'info' | 'warn' | 'approval' };

/** 待答复的审批。choices 由远端方言给出,标签沿用舰队视图的中文映射。 */
type PendingApproval = { approvalId: string; command: string; choices: string[] };

function approvalChoiceLabel(choice: string): string {
  const normalized = choice.toLowerCase();
  if (['once', 'allow_once'].includes(normalized)) return '批准一次';
  if (['always', 'allow_always', 'session'].includes(normalized)) return '本会话允许';
  if (['deny', 'reject'].includes(normalized)) return '拒绝';
  return choice;
}

/** 把一帧 harness 事件压成一行日志。未知帧原样显示,不静默吞掉。 */
function describe(frame: Record<string, unknown>): LogLine | null {
  const seq = Number(frame.seq ?? 0);
  const type = String(frame.type ?? '');
  if (type === 'tool.started' || type === 'tool.completed') {
    const name = String(frame.name ?? frame.tool ?? 'tool');
    const args = typeof frame.args === 'string' ? frame.args : '';
    return { seq, text: `✓ ${name}${args ? ` · ${args}` : ''}`, tone: 'info' };
  }
  if (type === 'message.delta' || type === 'message.completed') {
    const text = String(frame.text ?? frame.content ?? '').trim();
    return text ? { seq, text, tone: 'info' } : null;
  }
  if (type === 'approval.requested') {
    return { seq, text: `⏸ ${String(frame.command ?? '等待审批')}`, tone: 'approval' };
  }
  if (type === 'run.completed') return { seq, text: '■ 运行结束', tone: 'warn' };
  if (type === 'run.failed') return { seq, text: `■ 运行失败 · ${String(frame.error ?? '')}`, tone: 'warn' };
  return { seq, text: `· ${type || JSON.stringify(frame).slice(0, 160)}`, tone: 'info' };
}

/**
 * 接管远程会话 —— 全量回放 + 实时跟随。
 *
 * 走服务端那条 SSE 代理:`?after=N` 先把这台机器上该会话的历史事件按 seq
 * 全量回放,再无缝转入实时。断线重连时带上已收到的最大 seq,不丢不重。
 * 这里刻意只做「看 + 拍板 + 叫停」三件事:远程会话的家在那台机器上,
 * leocodebox 不复制它的状态。
 */
export default function RemoteSessionPanel({ target, onClose }: RemoteSessionPanelProps) {
  const { t } = useTranslation();
  const [lines, setLines] = useState<LogLine[]>([]);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [connected, setConnected] = useState(false);
  const [draft, setDraft] = useState('');
  const lastSeqRef = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let source: EventSource | null = null;
    let retryTimer: number | undefined;
    let closed = false;

    const connect = () => {
      if (closed) return;
      const url = `/api/leophone/fleet/machines/${encodeURIComponent(target.machine)}`
        + `/sessions/${encodeURIComponent(target.sessionId)}/events?after=${lastSeqRef.current}`;
      source = new EventSource(url, { withCredentials: true });
      source.onopen = () => setConnected(true);
      source.onmessage = (event) => {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(event.data) as Record<string, unknown>;
        } catch {
          return;
        }
        const seq = Number(frame.seq ?? 0);
        if (seq > lastSeqRef.current) lastSeqRef.current = seq;
        if (String(frame.type) === 'approval.requested') {
          setApproval({
            approvalId: String(frame.approval_id ?? frame.approvalId ?? ''),
            command: String(frame.command ?? ''),
            choices: Array.isArray(frame.choices) ? frame.choices.map(String) : ['once', 'always', 'deny'],
          });
        }
        if (String(frame.type) === 'approval.resolved') setApproval(null);
        const line = describe(frame);
        if (line) setLines((previous) => previous.concat(line).slice(-400));
      };
      source.onerror = () => {
        setConnected(false);
        source?.close();
        // 断线续传:带着已收到的最大 seq 重连,回放缺口后继续跟随。
        retryTimer = window.setTimeout(connect, 2_000);
      };
    };

    connect();
    return () => {
      closed = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      source?.close();
    };
  }, [target.machine, target.sessionId]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [lines.length]);

  const respond = useCallback(async (choice: string) => {
    if (!approval) return;
    setApproval(null);
    try {
      await apiClient.post('/api/leophone/approvals/respond', {
        machine: target.machine,
        session_id: target.sessionId,
        approval_id: approval.approvalId,
        choice,
      });
    } catch (error) {
      console.error('[RemoteSessionPanel] approval failed:', error);
    }
  }, [approval, target.machine, target.sessionId]);

  const drive = useCallback(async (action: 'send' | 'stop', body: unknown) => {
    try {
      await apiClient.post(
        `/api/leophone/fleet/machines/${encodeURIComponent(target.machine)}`
        + `/sessions/${encodeURIComponent(target.sessionId)}/${action}`,
        body,
      );
    } catch (error) {
      console.error(`[RemoteSessionPanel] ${action} failed:`, error);
    }
  }, [target.machine, target.sessionId]);

  return (
    <section className="flex min-w-0 flex-1 flex-col px-[26px] pb-3.5 pt-[18px]">
      <div className="flex items-center gap-2.5">
        <span className="text-[14.5px] font-bold text-foreground">{target.machine}</span>
        <span className="font-mono text-[10px] text-wb-faint">
          {target.harness ? `${target.harness} · ` : ''}{target.sessionId.slice(0, 12)}
        </span>
        <span
          className={`wb-badge-live inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[10px] ${connected ? 'text-primary' : 'text-wb-faint'}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-primary' : 'bg-wb-faint'}`} />
          {connected
            ? t('workbench.following', { defaultValue: '正在跟随' })
            : t('workbench.reconnecting', { defaultValue: '重连中' })}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => void drive('stop', {})}
            title={t('workbench.stopRun', { defaultValue: '停止运行' })}
            aria-label={t('workbench.stopRun', { defaultValue: '停止运行' })}
            className="wb-chip-button h-[26px] w-[26px] text-destructive"
          >
            <Square className="h-2.5 w-2.5 fill-current" />
          </button>
          <button
            type="button"
            onClick={onClose}
            title={t('workbench.leaveRemote', { defaultValue: '退出接管' })}
            aria-label={t('workbench.leaveRemote', { defaultValue: '退出接管' })}
            className="wb-chip-button h-[26px] w-[26px]"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>

      <div
        ref={logRef}
        className="wb-log-surface mt-3 min-h-0 flex-1 overflow-y-auto rounded-xl px-[18px] py-4 font-mono text-[11.5px] leading-[2.1] text-muted-foreground"
      >
        {lines.map((line, index) => (
          <div
            key={`${line.seq}-${index}`}
            className={`wb-anim-entry ${line.tone === 'approval' ? 'text-warning' : line.tone === 'warn' ? 'text-foreground' : ''}`}
          >
            {line.text}
          </div>
        ))}
      </div>

      {approval && (
        <div className="wb-anim-card mt-2.5 rounded-xl bg-warning/10 px-[15px] py-3 ring-1 ring-inset ring-warning/35">
          <p className="mb-2.5 font-mono text-[11.5px] text-warning">{approval.command}</p>
          <div className="flex max-w-[420px] gap-2">
            {approval.choices.map((choice, index) => (
              <button
                key={choice}
                type="button"
                onClick={() => void respond(choice)}
                className={index === 0
                  ? 'flex-1 cursor-pointer rounded-lg border-none bg-foreground py-1.5 text-[11.5px] font-bold text-background active:scale-95'
                  : 'wb-chip-button flex-1 py-1.5 text-[11.5px] font-semibold text-foreground'}
              >
                {approvalChoiceLabel(choice)}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mt-2.5 flex items-center gap-2.5 rounded-[13px] bg-muted py-1.5 pl-3.5 pr-2 ring-1 ring-inset ring-border">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
            const text = draft.trim();
            if (!text) return;
            setDraft('');
            void drive('send', { prompt: text });
          }}
          aria-label={t('workbench.remoteReply', { defaultValue: '追问远程会话' })}
          placeholder={t('workbench.remoteReplyPlaceholder', { defaultValue: '继续驾驶这台机器上的会话…' })}
          className="min-w-0 flex-1 border-none bg-transparent font-sans text-[13px] text-foreground outline-none placeholder:text-wb-faint"
        />
      </div>
    </section>
  );
}
