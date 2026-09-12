import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, Square, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { apiClient } from '../../utils/apiClient';

import {
  applyApprovalFrame,
  describeRemoteEvent,
  isTerminalRemoteEvent,
  readRemoteSse,
  readRemoteDurability,
  UNKNOWN_REMOTE_DURABILITY,
  type RemoteDurability,
  type PendingApproval,
  type RemoteLogLine,
} from './remoteSessionEvents';

export type RemoteTarget = { machine: string; sessionId: string; harness?: string };

type RemoteSessionPanelProps = {
  target: RemoteTarget;
  onClose: () => void;
};

function approvalChoiceLabel(choice: string): string {
  const normalized = choice.toLowerCase();
  if (['once', 'allow_once'].includes(normalized)) return '批准一次';
  if (['always', 'allow_always', 'session'].includes(normalized)) return '本会话允许';
  if (['deny', 'reject'].includes(normalized)) return '拒绝';
  return choice;
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
  const [lines, setLines] = useState<Array<RemoteLogLine & { id: string }>>([]);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const approval = approvals[0] ?? null;
  const [connected, setConnected] = useState(false);
  const [finished, setFinished] = useState(false);
  const [durability, setDurability] = useState<RemoteDurability>(UNKNOWN_REMOTE_DURABILITY);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [hasNewOutput, setHasNewOutput] = useState(false);
  const followingRef = useRef(true);
  const operationRef = useRef<symbol | null>(null);
  const draftsRef = useRef(new Map<string, string>());
  const draftRevisionRef = useRef(0);
  const targetKey = JSON.stringify([target.machine, target.sessionId]);
  const lastSeqRef = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const abort = new AbortController();
    let retryTimer: number | undefined;
    let closed = false;
    // 这条流里有没有出现过终态帧。服务端一到终态就主动 res.end(),
    // 所以「流结束了」本身不代表出错 —— 得看最后收到的是不是 run.*。
    let sawTerminal = false;
    let localLineId = 0;
    operationRef.current = null;
    draftRevisionRef.current += 1;
    followingRef.current = true;
    setHasNewOutput(false);
    setBusy(false);
    lastSeqRef.current = 0;
    setLines([]);
    setApprovals([]);
    setConnected(false);
    setFinished(false);
    setDurability(UNKNOWN_REMOTE_DURABILITY);
    setDraft(draftsRef.current.get(targetKey) ?? '');
    setError('');
    setConnectionError('');

    const connect = async () => {
      if (closed) return;
      const url = `/api/leophone/fleet/machines/${encodeURIComponent(target.machine)}`
        + `/sessions/${encodeURIComponent(target.sessionId)}/events?after=${lastSeqRef.current}&journal_status=1`;
      try {
        const response = await apiClient.raw(url, {
          headers: { Accept: 'text/event-stream' },
          signal: abort.signal,
        });
        if (!response.body) throw new Error('远程事件流不可用');
        if (closed || abort.signal.aborted) return;
        setConnected(true);
        setConnectionError('');
        await readRemoteSse(response.body, (frame) => {
          if (closed || abort.signal.aborted) return;
          if (frame.type === 'durability') {
            const control = readRemoteDurability(frame);
            if (control) setDurability(control);
            return;
          }
          const rawSeq = Number(frame.seq ?? 0);
          const seq = Number.isSafeInteger(rawSeq) && rawSeq > 0 ? rawSeq : 0;
          if (seq > 0 && seq <= lastSeqRef.current) return;
          if (frame.durability === 'pending' || frame.durability === 'unavailable') {
            setDurability((current) => ({ ...current, state: frame.durability === 'unavailable' ? 'degraded' : current.state === 'degraded' ? 'degraded' : 'pending' }));
          }
          if (seq > lastSeqRef.current) lastSeqRef.current = seq;
          if (isTerminalRemoteEvent(frame)) sawTerminal = true;
          setApprovals((current) => applyApprovalFrame(current, frame));
          const line = describeRemoteEvent(frame);
          if (line) {
            const id = seq > 0 ? `seq:${seq}` : `local:${++localLineId}`;
            setLines((previous) => previous.concat({ ...line, id }).slice(-400));
          }
        });
        if (closed || abort.signal.aborted) return;
        setConnected(false);
        if (sawTerminal) {
          // 正常收尾:会话已经是终态,再连也只会回放完立刻被关流。
          // 旧代码把这条路和出错混成一条,于是每个远程任务跑完都变成
          // 红字报错 + 每 2 秒一次的永久重连。
          setFinished(true);
          setApprovals([]);
          return;
        }
        throw new Error('远程事件流已结束');
      } catch (streamError) {
        if (closed || abort.signal.aborted) return;
        setConnected(false);
        setConnectionError(streamError instanceof Error ? streamError.message : '远程事件流断开');
        retryTimer = window.setTimeout(() => void connect(), 2_000);
      }
    };

    void connect();
    return () => {
      closed = true;
      operationRef.current = null;
      if (retryTimer) window.clearTimeout(retryTimer);
      abort.abort();
    };
  }, [target.machine, target.sessionId, targetKey]);

  // The tail changes after the 400-row window fills; length alone never does.
  // Keep stable rows and let the reader decide when to follow live output.
  useLayoutEffect(() => {
    if (!lines.length) return;
    if (followingRef.current) {
      logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
    } else {
      setHasNewOutput(true);
    }
  }, [lines]);

  const followLatest = () => {
    followingRef.current = true;
    setHasNewOutput(false);
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  };

  const respond = useCallback(async (choice: string) => {
    if (!approval || operationRef.current || finished) return;
    const operation = Symbol('approval');
    operationRef.current = operation;
    setBusy(true);
    setError('');
    try {
      await apiClient.post('/api/leophone/approvals/respond', {
        machine: target.machine,
        session_id: target.sessionId,
        approval_id: approval.approvalId,
        choice,
      });
      if (operationRef.current === operation) {
        setApprovals((current) => current.filter((item) => item.approvalId !== approval.approvalId));
      }
    } catch (error) {
      if (operationRef.current === operation) setError(error instanceof Error ? error.message : '审批发送失败');
    } finally {
      if (operationRef.current === operation) {
        operationRef.current = null;
        setBusy(false);
      }
    }
  }, [approval, finished, target.machine, target.sessionId]);

  const drive = useCallback(async (action: 'send' | 'stop', body: unknown): Promise<boolean> => {
    if (operationRef.current || finished) return false;
    const operation = Symbol(action);
    operationRef.current = operation;
    setBusy(true);
    setError('');
    try {
      await apiClient.post(
        `/api/leophone/fleet/machines/${encodeURIComponent(target.machine)}`
        + `/sessions/${encodeURIComponent(target.sessionId)}/${action}`,
        body,
      );
      return operationRef.current === operation;
    } catch (error) {
      if (operationRef.current === operation) setError(error instanceof Error ? error.message : `${action} 失败`);
      return false;
    } finally {
      if (operationRef.current === operation) {
        operationRef.current = null;
        setBusy(false);
      }
    }
  }, [finished, target.machine, target.sessionId]);

  return (
    <section className="flex min-w-0 flex-1 flex-col px-[26px] pb-3.5 pt-[18px]">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="max-w-[45%] truncate text-[14.5px] font-bold text-foreground" title={target.machine}>{target.machine}</span>
        <span className="font-mono text-[10px] text-wb-faint">
          {target.harness ? `${target.harness} · ` : ''}{target.sessionId.slice(0, 12)}
        </span>
        <span
          role="status"
          className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[10px] ${connected ? 'text-primary' : 'text-wb-faint'}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-primary' : 'bg-wb-faint'}`} />
          {connected
            ? t('workbench.following', { defaultValue: '正在跟随' })
            : finished
              ? t('workbench.remoteFinished', { defaultValue: '已结束' })
              : t('workbench.reconnecting', { defaultValue: '重连中' })}
        </span>
        <span
          role="status"
          data-remote-durability={durability.state}
          title={t('workbench.journalDetail', { durable: durability.durableSeq, latest: durability.latestSeq, missing: durability.missingRanges, defaultValue: 'Durable {{durable}} / received {{latest}} · {{missing}} missing ranges' })}
          className={`text-[10px] ${durability.state === 'degraded' ? 'text-warning' : 'text-wb-faint'}`}
        >
          {t(`workbench.journal.${durability.state}`, { defaultValue: ({ unknown: '保存状态未知', pending: '日志保存中', durable: '日志已保存', degraded: '日志保存异常' })[durability.state] })}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => void drive('stop', {})}
            disabled={busy || finished}
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
        aria-label={t('workbench.remoteLog', { defaultValue: '远程运行输出（最近 400 行）' })}
        tabIndex={0}
        onScroll={(event) => {
          const element = event.currentTarget;
          followingRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 48;
          if (followingRef.current) setHasNewOutput(false);
        }}
        className="wb-log-surface mt-3 min-h-0 flex-1 overflow-y-auto rounded-xl px-[18px] py-4 font-mono text-[11.5px] leading-[2.1] text-muted-foreground"
      >
        {lines.map((line) => (
          <div
            key={line.id}
            className={`${line.tone === 'approval' ? 'text-warning' : line.tone === 'warn' ? 'text-foreground' : ''}`}
          >
            {line.text}
          </div>
        ))}
      </div>

      {hasNewOutput && (
        <button type="button" data-remote-latest onClick={followLatest} className="wb-chip-button mt-2 self-center px-3 py-1.5 text-xs">
          <ArrowDown className="h-3.5 w-3.5" aria-hidden />
          {t('workbench.remoteLatest', { defaultValue: '有新输出 · 回到最新' })}
        </button>
      )}

      {approval && (
        <div className="wb-anim-card mt-2.5 rounded-xl bg-warning/10 px-[15px] py-3 ring-1 ring-inset ring-warning/35">
          <p className="mb-2.5 font-mono text-[11.5px] text-warning">{approval.command}</p>
          <div className="flex max-w-[420px] gap-2">
            {approval.choices.map((choice, index) => (
              <button
                key={choice}
                type="button"
                onClick={() => void respond(choice)}
                disabled={busy}
                className={index === 0
                  ? 'flex-1 cursor-pointer rounded-lg border-none bg-foreground py-1.5 text-[11.5px] font-bold text-background active:scale-[0.98]'
                  : 'wb-chip-button flex-1 py-1.5 text-[11.5px] font-semibold text-foreground'}
              >
                {approvalChoiceLabel(choice)}
              </button>
            ))}
          </div>
        </div>
      )}

      {(error || connectionError) && <p role="alert" className="mt-2 text-[11px] text-destructive">{error || connectionError}</p>}

      <div className="mt-2.5 flex items-center gap-2.5 rounded-[13px] bg-muted py-1.5 pl-3.5 pr-2 ring-1 ring-inset ring-border">
        <input
          value={draft}
          onChange={(event) => {
            draftRevisionRef.current += 1;
            draftsRef.current.set(targetKey, event.target.value);
            setDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing || busy || finished) return;
            event.preventDefault();
            const text = draft.trim();
            if (!text) return;
            const submittedRevision = draftRevisionRef.current;
            void drive('send', { text }).then((ok) => {
              if (ok && draftRevisionRef.current === submittedRevision) {
                draftsRef.current.delete(targetKey);
                setDraft('');
              }
            });
          }}
          // 会话已终态就别再让人往里打字了:那边的进程早没了,send 只会 4xx。
          disabled={finished}
          aria-label={t('workbench.remoteReply', { defaultValue: '追问远程会话' })}
          placeholder={finished
            ? t('workbench.remoteFinishedHint', { defaultValue: '这个会话已经结束' })
            : t('workbench.remoteReplyPlaceholder', { defaultValue: '继续驾驶这台机器上的会话…' })}
          className="min-w-0 flex-1 border-none bg-transparent font-sans text-[13px] text-foreground outline-none placeholder:text-wb-faint disabled:cursor-not-allowed"
        />
      </div>
    </section>
  );
}
