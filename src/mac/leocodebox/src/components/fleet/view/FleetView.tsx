import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Copy,
  LoaderCircle,
  Monitor,
  RefreshCw,
  ShieldCheck,
  Smartphone,
} from 'lucide-react';

import { apiClient } from '../../../utils/apiClient';

import CollectionsMirror from './CollectionsMirror';

type Session = {
  session_id: string;
  harness: string;
  status: string;
  cwd: string;
  waiting_for_approval?: boolean;
};

type Machine = {
  name: string;
  online: boolean;
  reachable: boolean;
  activeCount: number;
  sessions: Session[];
};

type Approval = {
  machine: string;
  session_id: string;
  harness: string;
  approval_id: string;
  command: string;
  choices: string[];
};

const POLL_MS = 15_000;
const RELAY_CONFIG_PATH = '~/.leoagent/relay.json';

function encodePair(apiRoot: string, machine: string): string {
  return `leoagent-body:v1|${JSON.stringify({ apiRoot, machine })}`;
}

function approvalChoiceLabel(choice: string): string {
  switch (choice.toLowerCase()) {
    case 'once':
    case 'allow_once':
      return '批准一次';
    case 'always':
    case 'allow_always':
    case 'session':
      return '本会话允许';
    case 'deny':
    case 'reject':
      return '拒绝';
    default:
      return choice;
  }
}

function isDenyChoice(choice: string): boolean {
  const normalized = choice.toLowerCase();
  return ['deny', 'reject', 'cancel', 'abort', 'decline', 'never', 'disallow', 'no', '放弃', '拒绝']
    .some((word) => normalized === word || normalized.includes(word));
}

function isAllowChoice(choice: string): boolean {
  const normalized = choice.toLowerCase();
  return ['once', 'allow_once', 'always', 'allow_always', 'session', 'allow', 'approve', 'accept', 'yes']
    .includes(normalized);
}

function approvalKey(approval: Approval): string {
  return `${approval.machine}:${approval.session_id}:${approval.approval_id}`;
}

function machineStatus(machine: Machine): { label: string; tone: string } {
  if (!machine.online) return { label: '离线', tone: 'bg-muted-foreground' };
  if (!machine.reachable) return { label: '没有响应', tone: 'bg-warning' };
  if (machine.sessions.some((session) => session.waiting_for_approval)) return { label: '等待审批', tone: 'bg-warning' };
  if (machine.activeCount > 0) return { label: `${machine.activeCount} 个进行中`, tone: 'bg-success' };
  return { label: '空闲', tone: 'bg-success' };
}

export default function FleetView() {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Map<string, string>>(() => new Map());
  const [copied, setCopied] = useState(false);
  const [copiedPair, setCopiedPair] = useState<string | null>(null);
  const [relayApiRoot, setRelayApiRoot] = useState('');
  const inFlight = useRef(false);
  const hasLoaded = useRef(false);
  const busyApprovals = useRef(new Set<string>());

  const load = useCallback(async () => {
    if (document.visibilityState === 'hidden' || inFlight.current) return;
    inFlight.current = true;
    if (hasLoaded.current) setRefreshing(true);
    try {
      const [fleetResult, pendingResult] = await Promise.allSettled([
        apiClient.get<{ configured?: boolean; machines?: Machine[]; relayApiRoot?: string }>('/api/leophone/fleet'),
        apiClient.get<{ approvals?: Approval[] }>('/api/leophone/approvals'),
      ]);
      const failures: string[] = [];
      if (fleetResult.status === 'fulfilled') {
        setConfigured(fleetResult.value?.configured !== false);
        setMachines(fleetResult.value?.machines ?? []);
        if (typeof fleetResult.value?.relayApiRoot === 'string') setRelayApiRoot(fleetResult.value.relayApiRoot);
      } else {
        failures.push(`Mac 状态：${fleetResult.reason instanceof Error ? fleetResult.reason.message : '读取失败'}`);
      }
      if (pendingResult.status === 'fulfilled') {
        setApprovals(pendingResult.value?.approvals ?? []);
      } else {
        failures.push(`待审批：${pendingResult.reason instanceof Error ? pendingResult.reason.message : '读取失败'}`);
      }
      setError(failures.length > 0 ? `部分数据未更新（${failures.join('；')}）` : null);
      if (fleetResult.status === 'fulfilled' || pendingResult.status === 'fulfilled') {
        setLastUpdatedAt(new Date());
      }
    } finally {
      inFlight.current = false;
      setLoading(false);
      setRefreshing(false);
      hasLoaded.current = true;
    }
  }, []);

  const [tick, setTick] = useState(0);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      void load();
      setTick((value) => value + 1);
    }, POLL_MS);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [load]);

  const respond = async (approval: Approval, choice: string) => {
    const key = approvalKey(approval);
    if (busyApprovals.current.has(key)) return;
    busyApprovals.current.add(key);
    setBusy((current) => new Map(current).set(key, choice));
    try {
      await apiClient.post('/api/leophone/approvals/respond', {
        machine: approval.machine,
        session_id: approval.session_id,
        approval_id: approval.approval_id,
        choice,
      });
      setApprovals((current) => current.filter((item) => approvalKey(item) !== key));
      await load();
    } catch (respondError) {
      setError(respondError instanceof Error ? respondError.message : '应答没有送达，请重试');
    } finally {
      busyApprovals.current.delete(key);
      setBusy((current) => {
        const next = new Map(current);
        next.delete(key);
        return next;
      });
    }
  };

  const copyRelayPath = async () => {
    try {
      await navigator.clipboard.writeText(RELAY_CONFIG_PATH);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError(`无法自动复制，请手动打开 ${RELAY_CONFIG_PATH}`);
    }
  };

  const copyPair = async (machine: string) => {
    if (!relayApiRoot) {
      setError('中继地址未知，请先确认 ~/.leoagent/relay.json 已配置');
      return;
    }
    try {
      await navigator.clipboard.writeText(encodePair(relayApiRoot, machine));
      setCopiedPair(machine);
      window.setTimeout(() => setCopiedPair(null), 1800);
    } catch {
      setError('无法复制配对码');
    }
  };

  const onlineCount = useMemo(() => machines.filter((machine) => machine.online && machine.reachable).length, [machines]);
  const activeCount = useMemo(() => machines.reduce((sum, machine) => sum + machine.activeCount, 0), [machines]);
  const onlineProgress = machines.length > 0 ? Math.round((onlineCount / machines.length) * 100) : 0;
  const lastUpdatedLabel = lastUpdatedAt
    ? lastUpdatedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '尚未完成同步';

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto max-w-[1120px] space-y-4 px-5 py-5 lg:px-8 lg:py-7">
        <section className="rounded-xl border border-border bg-card px-5 py-5 shadow-elevation-1 lg:px-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-4">
              <span className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Monitor className="h-6 w-6" />
              </span>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">LeoPhoneAgent · 跨端执行</p>
                <h1 className="mt-1.5 text-2xl font-semibold tracking-tight text-foreground">我的机器</h1>
                <p className="mt-1 max-w-[680px] text-sm leading-6 text-muted-foreground">
                  这里管理舰队里的 Mac 与作为身体的 Android / 鸿蒙：进行中的任务、待审批操作，以及手机收藏镜像。
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading || refreshing}
              data-state={loading || refreshing ? 'loading' : 'idle'}
              className="leo-status-pill leo-squish inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 py-2 text-sm font-medium text-foreground hover:bg-accent disabled:cursor-wait disabled:opacity-70"
            >
              <RefreshCw className={`h-4 w-4 ${loading || refreshing ? 'animate-spin' : ''}`} />
              {loading || refreshing ? '同步中' : '刷新'}
            </button>
          </div>

          <div className="mt-5 grid gap-2.5 sm:grid-cols-3">
            <div className="rounded-xl bg-secondary/65 px-4 py-3">
              <p className="text-xs text-muted-foreground">在线机器</p>
              <p className="mt-1 text-xl font-semibold text-foreground">{onlineCount} / {machines.length}</p>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border/70" aria-hidden="true">
                <div className="leo-elastic-progress h-full rounded-full bg-success" style={{ width: `${onlineProgress}%` }} />
              </div>
            </div>
            <div className="rounded-xl bg-secondary/65 px-4 py-3">
              <p className="text-xs text-muted-foreground">进行中</p>
              <p className="mt-1 text-xl font-semibold text-foreground">{activeCount}</p>
            </div>
            <div className="rounded-xl bg-secondary/65 px-4 py-3">
              <p className="text-xs text-muted-foreground">审批</p>
              <p className="mt-1 text-xl font-semibold text-foreground">{approvals.length}</p>
            </div>
          </div>
        </section>

        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-xl border border-destructive/35 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <CircleAlert className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span className="flex-1">{error}</span>
            <button type="button" onClick={() => setError(null)} className="font-medium">关闭</button>
          </div>
        )}

        {loading ? (
          <section aria-live="polite" className="rounded-xl border border-border bg-card p-6 shadow-elevation-1">
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <LoaderCircle className="h-5 w-5 animate-spin" />
              </span>
              <div>
                <h2 className="text-base font-semibold text-foreground">正在同步舰队</h2>
                <p className="mt-0.5 text-sm text-muted-foreground">读取在线状态、进行中任务和待审批操作。</p>
              </div>
            </div>
          </section>
        ) : !configured ? (
          <section className="rounded-xl border border-border bg-card p-6 text-center shadow-elevation-1">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Smartphone className="h-7 w-7" />
            </span>
            <h2 className="mt-4 text-xl font-semibold text-foreground">先连接自己的中继</h2>
            <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
              配好一把共享密钥后，MacBook Pro、Mac mini 和 Mac Studio 会自动出现在这里；手机走蜂窝网络也能控制。
            </p>
            <div className="mx-auto mt-5 max-w-lg rounded-xl border border-border bg-background p-3 text-left">
              <p className="text-xs font-medium text-muted-foreground">中继配置文件</p>
              <div className="mt-2 flex items-center justify-between gap-3">
                <code className="min-w-0 truncate text-sm text-foreground">{RELAY_CONFIG_PATH}</code>
                <button type="button" onClick={() => void copyRelayPath()} className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground">
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  {copied ? '已复制' : '复制路径'}
                </button>
              </div>
            </div>
          </section>
        ) : (
          <>
            {approvals.length > 0 && (
              <section className="rounded-xl border border-warning/35 bg-card p-5 shadow-elevation-1">
                <div className="flex items-center gap-3">
                  <span className="bg-warning/12 flex h-10 w-10 items-center justify-center rounded-xl text-warning">
                    <ShieldCheck className="h-5 w-5" />
                  </span>
                  <div>
                    <h2 className="text-base font-semibold text-foreground">审批 · {approvals.length}</h2>
                    <p className="text-xs text-muted-foreground">批准或拒绝后，结果会立即送回对应机器。</p>
                  </div>
                </div>
                <div className="mt-4 space-y-3">
                  {approvals.map((approval) => (
                    <article key={`${approval.machine}-${approval.approval_id}`} className="rounded-xl border border-border bg-background p-4">
                      <p className="text-xs font-medium text-muted-foreground">{approval.machine} · {approval.harness}</p>
                      <p className="mt-2 break-all rounded-lg bg-secondary/70 px-3 py-2 font-mono text-sm text-foreground">{approval.command || '(无命令内容)'}</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {(approval.choices?.length ? approval.choices : ['once', 'deny']).map((choice) => {
                          const key = approvalKey(approval);
                          const activeChoice = busy.get(key);
                          const waiting = activeChoice !== undefined;
                          const sendingThisChoice = activeChoice === choice;
                          const deny = isDenyChoice(choice);
                          const allow = isAllowChoice(choice);
                          return (
                            <button
                              key={choice}
                              type="button"
                              disabled={waiting}
                              onClick={() => void respond(approval, choice)}
                              data-state={sendingThisChoice ? 'loading' : 'idle'}
                              className={allow
                                ? 'leo-squish inline-flex min-h-10 items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:cursor-wait disabled:opacity-70'
                                : deny
                                  ? 'leo-squish inline-flex min-h-10 items-center gap-2 rounded-lg border border-destructive/35 bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive disabled:cursor-wait disabled:opacity-50'
                                  : 'leo-squish inline-flex min-h-10 items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-foreground disabled:cursor-wait disabled:opacity-50'}
                            >
                              {sendingThisChoice
                                ? <LoaderCircle className="h-4 w-4 animate-spin" />
                                : allow && <CheckCircle2 className="h-4 w-4" />}
                              {sendingThisChoice ? '发送中' : approvalChoiceLabel(choice)}
                            </button>
                          );
                        })}
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            )}

            <section className="rounded-[22px] border border-border bg-card p-5 shadow-elevation-1">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-foreground">已连接的机器</h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">每 15 秒自动刷新 · 上次同步 {lastUpdatedLabel}</p>
                </div>
                <span className="rounded-full bg-success/10 px-2.5 py-1 text-xs font-medium text-success">{onlineCount} 在线</span>
              </div>

              {machines.length === 0 ? (
                <div className="py-10 text-center">
                  <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-secondary text-muted-foreground"><Monitor className="h-6 w-6" /></span>
                  <h3 className="mt-3 text-base font-semibold text-foreground">中继已配置，正在等机器上线</h3>
                  <p className="mt-1 text-sm text-muted-foreground">确认 Mac 工作台或 Android 本机 Agent 已注册到中继，然后刷新此页。</p>
                </div>
              ) : (
                <div className="mt-4 grid gap-3 lg:grid-cols-3">
                  {machines.map((machine) => {
                    const status = machineStatus(machine);
                    return (
                      <article key={machine.name} className="rounded-xl border border-border bg-background p-4">
                        <div className="flex items-start justify-between gap-3">
                          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><Monitor className="h-5 w-5" /></span>
                          <span className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-2 py-1 text-xs text-muted-foreground"><span className={`h-2 w-2 rounded-full ${status.tone}`} />{status.label}</span>
                        </div>
                        <h3 className="mt-3 text-base font-semibold text-foreground">{machine.name}</h3>
                        <button
                          type="button"
                          onClick={() => void copyPair(machine.name)}
                          className="mt-2 inline-flex min-h-9 items-center gap-1.5 text-xs font-medium text-primary"
                        >
                          {copiedPair === machine.name ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                          {copiedPair === machine.name ? '已复制配对码' : '复制配对码'}
                        </button>
                        {machine.sessions.length === 0 ? (
                          <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground"><Clock3 className="h-3.5 w-3.5" />当前没有任务</p>
                        ) : (
                          <ul className="mt-3 space-y-2">
                            {machine.sessions.map((session) => (
                              <li key={session.session_id} className="rounded-lg bg-secondary/65 px-3 py-2 text-xs text-muted-foreground">
                                <div className="flex items-center justify-between gap-2"><span className="font-medium text-foreground">{session.harness}</span><span>{session.status}</span></div>
                                <p className="mt-1 truncate opacity-75" title={session.cwd}>{session.cwd}</p>
                              </li>
                            ))}
                          </ul>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          </>
        )}

        <CollectionsMirror refreshTick={tick} />
      </div>
    </div>
  );
}
