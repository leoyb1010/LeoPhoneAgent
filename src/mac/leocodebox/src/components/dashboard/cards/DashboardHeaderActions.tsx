import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Settings2 } from 'lucide-react';

type DashboardHeaderActionsProps = {
  onShowSettings: () => void;
  onRefresh: () => Promise<{ ok: boolean }>;
};

type RefreshState = 'idle' | 'loading' | 'success' | 'error';

export default function DashboardHeaderActions({ onShowSettings, onRefresh }: DashboardHeaderActionsProps) {
  const [refreshState, setRefreshState] = useState<RefreshState>('idle');
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (resetTimer.current !== null) clearTimeout(resetTimer.current);
  }, []);

  const handleRefresh = useCallback(async () => {
    if (refreshState === 'loading') return;
    if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    setRefreshState('loading');
    try {
      const result = await onRefresh();
      setRefreshState(result.ok ? 'success' : 'error');
    } catch {
      setRefreshState('error');
    }
    resetTimer.current = setTimeout(() => setRefreshState('idle'), 2_000);
  }, [onRefresh, refreshState]);

  const refreshLabel = refreshState === 'loading'
    ? '刷新中'
    : refreshState === 'success'
      ? '已更新'
      : refreshState === 'error'
        ? '刷新失败'
        : '刷新状态';

  return (
    <div className="flex items-center gap-2" aria-label="首页控制">
      <button
        type="button"
        onClick={onShowSettings}
        aria-label="打开控制设置"
        aria-haspopup="dialog"
        aria-controls="leocodebox-settings-dialog"
        className="leo-squish inline-flex h-9 items-center gap-2 rounded-xl border border-border bg-background px-3 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Settings2 className="h-4 w-4" />
        <span>控制设置</span>
      </button>
      <button
        type="button"
        onClick={() => void handleRefresh()}
        disabled={refreshState === 'loading'}
        aria-label={refreshLabel}
        aria-busy={refreshState === 'loading'}
        className={`leo-squish inline-flex h-9 min-w-[88px] items-center justify-center gap-2 rounded-xl border border-border bg-background px-3 text-xs font-medium hover:bg-accent disabled:cursor-wait disabled:opacity-80 ${refreshState === 'error' ? 'text-destructive' : refreshState === 'success' ? 'text-success' : 'text-muted-foreground hover:text-foreground'}`}
      >
        <RefreshCw className={`h-4 w-4 ${refreshState === 'loading' ? 'animate-spin' : ''}`} />
        <span aria-live="polite">{refreshLabel}</span>
      </button>
    </div>
  );
}
