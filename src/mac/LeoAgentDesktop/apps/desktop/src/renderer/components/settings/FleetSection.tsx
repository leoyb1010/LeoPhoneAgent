/**
 * FleetSection — Mac 舰队(LeoAgent 分叉新增)。
 *
 * 三台 Mac 经自营中继(常开 cortex)组网,这里显示每台的在线状态与活跃
 * 会话数。数据由 main 进程经 `leo:fleet-status` IPC 拉取(relay 配置在
 * ~/.leoagent/relay.json,renderer 不接触密钥)。
 *
 * 这个 tab 替代了"同账号设备互控"(上游云 relay,个人版无账号不可用);
 * SSH 远程主机作为备用方案仍在「我的设备 → 远程连接」里。
 */
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';

interface FleetMachine {
  name: string;
  online: boolean;
  sessions?: number;
  version?: string;
}

interface FleetStatus {
  ok: boolean;
  error?: string;
  relayUrl?: string;
  machines: FleetMachine[];
}

declare global {
  interface Window {
    leoFleet?: { status: () => Promise<FleetStatus> };
  }
}

export function FleetSection() {
  const [status, setStatus] = useState<FleetStatus | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await window.leoFleet?.status();
      setStatus(next ?? { ok: false, error: '桥接不可用', machines: [] });
    } catch (err) {
      setStatus({ ok: false, error: String(err), machines: [] });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-16 font-semibold text-[var(--settings-section-title)]">Mac 舰队</h2>
          <p className="mt-1 text-13 text-[var(--settings-section-sublabel)]">
            我的 Mac 经自营中继组网;手机在任何网络都能连到在线的机器。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          aria-label="刷新"
          className="flex h-8 w-8 items-center justify-center rounded-full border border-[var(--settings-theme-card-border)] text-[var(--settings-section-sublabel)] transition-colors hover:bg-[var(--surface-hover)]"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : undefined} />
        </button>
      </div>

      {status?.error && (
        <div className="rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] p-4 text-13 text-[var(--settings-section-sublabel)]">
          舰队状态不可用:{status.error}
          <div className="mt-1">
            确认这台 Mac 的 ~/.leoagent/relay.json 已配置(装机脚本会写好),且中继在线。
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2">
        {(status?.machines ?? []).map((machine) => (
          <div
            key={machine.name}
            className="flex items-center gap-3 rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] px-4 py-3"
          >
            <span
              className={
                machine.online
                  ? 'h-2.5 w-2.5 rounded-full bg-emerald-500'
                  : 'h-2.5 w-2.5 rounded-full bg-neutral-400'
              }
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-14 font-medium text-[var(--settings-section-title)]">
                {machine.name}
              </div>
              <div className="text-12 text-[var(--settings-section-sublabel)]">
                {machine.online ? '在线' : '离线'}
                {machine.version ? ` · v${machine.version}` : ''}
              </div>
            </div>
            {typeof machine.sessions === 'number' && (
              <div className="text-12 text-[var(--settings-section-sublabel)]">
                {machine.sessions} 个会话
              </div>
            )}
          </div>
        ))}
        {status && !status.error && status.machines.length === 0 && (
          <div className="rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] p-4 text-13 text-[var(--settings-section-sublabel)]">
            中继在线,但还没有机器注册上来。
          </div>
        )}
      </div>
    </div>
  );
}
