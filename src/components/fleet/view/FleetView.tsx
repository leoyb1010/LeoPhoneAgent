import { useCallback, useEffect, useState } from 'react';

import { apiClient } from '../../../utils/apiClient';

import CollectionsMirror from './CollectionsMirror';

/**
 * [T-fleet-mac] 舰队视图 + 审批中心。
 *
 * 手机上早就能"在一处看全部 Mac、批全部待审批";Mac 端一直只知道自己。
 * 这一页让两端对称:坐在任何一台前面都能掌握全局。
 *
 * 风格上刻意克制:没有插画、没有色块阵、没有装饰图标。一台机器一行,
 * 状态用一个小圆点表达,剩下全是可读的字。要看的是"哪台在跑什么、
 * 谁在等我拍板",不是看图。
 */

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

export default function FleetView() {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [configured, setConfigured] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [fleet, pending] = await Promise.all([
        apiClient.get<{ configured?: boolean; machines?: Machine[] }>('/api/leophone/fleet'),
        apiClient.get<{ approvals?: Approval[] }>('/api/leophone/approvals'),
      ]);
      setConfigured(fleet?.configured !== false);
      setMachines(fleet?.machines ?? []);
      setApprovals(pending?.approvals ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取失败');
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const respond = async (approval: Approval, choice: string) => {
    setBusy(approval.approval_id);
    try {
      await apiClient.post('/api/leophone/approvals/respond', {
        machine: approval.machine,
        session_id: approval.session_id,
        approval_id: approval.approval_id,
        choice,
      });
      await load();
    } catch (e) {
      // 送不到就留着卡片并说明原因 —— 清掉它而 CLI 还在等是最坏的结果
      setError(e instanceof Error ? e.message : '应答未送达,请重试');
    } finally {
      setBusy(null);
    }
  };

  if (!configured) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        <p className="text-foreground">还没有配置中继</p>
        <p className="mt-2">
          在 <code className="rounded-md bg-muted px-1">~/.leoagent/relay.json</code> 里填好中继地址与钥匙后,这里会显示全部 Mac。
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-4">
      {error && (
        <p className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {approvals.length > 0 && (
        <section className="mb-5">
          <h2 className="text-sm font-medium text-foreground">等你拍板 · {approvals.length}</h2>
          <div className="mt-2 space-y-2">
            {approvals.map((approval) => (
              <div
                key={`${approval.machine}-${approval.approval_id}`}
                className="rounded-md border border-border p-3"
              >
                <p className="text-xs text-muted-foreground">
                  {approval.machine} · {approval.harness}
                </p>
                <p className="mt-1 break-all font-mono text-sm text-foreground">
                  {approval.command || '(无命令内容)'}
                </p>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    disabled={busy === approval.approval_id}
                    onClick={() => void respond(approval, 'once')}
                    className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
                  >
                    批准一次
                  </button>
                  <button
                    type="button"
                    disabled={busy === approval.approval_id}
                    onClick={() => void respond(approval, 'deny')}
                    className="rounded-md border border-border px-3 py-1 text-xs text-muted-foreground disabled:opacity-50"
                  >
                    拒绝
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="text-sm font-medium text-foreground">我的 Mac</h2>
        <div className="mt-2 space-y-2">
          {machines.length === 0 && (
            <p className="text-sm text-muted-foreground">还没有 Mac 连上中继。</p>
          )}
          {machines.map((machine) => (
            <div key={machine.name} className="rounded-md border border-border p-3">
              <div className="flex items-baseline gap-2">
                <span
                  className={`h-2 w-2 rounded-full ${
                    !machine.online || !machine.reachable
                      ? 'bg-muted-foreground'
                      : machine.sessions.some((s) => s.waiting_for_approval)
                        ? 'bg-amber-500'
                        : 'bg-emerald-500'
                  }`}
                />
                <span className="text-sm font-medium text-foreground">{machine.name}</span>
                <span className="text-xs text-muted-foreground">
                  {!machine.online
                    ? '离线'
                    : !machine.reachable
                      ? '没响应'
                      : machine.activeCount > 0
                        ? `${machine.activeCount} 个进行中`
                        : '空闲'}
                </span>
              </div>
              {machine.sessions.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {machine.sessions.map((session) => (
                    <li key={session.session_id} className="text-xs text-muted-foreground">
                      {session.harness} · {session.status}
                      {session.waiting_for_approval && (
                        <span className="ml-1 text-amber-600">等审批</span>
                      )}
                      <span className="ml-1 opacity-60">{session.cwd}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </section>

      <CollectionsMirror />
    </div>
  );
}
