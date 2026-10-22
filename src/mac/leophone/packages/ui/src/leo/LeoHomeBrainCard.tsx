import { Brain } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** Host 的 /api/leo/brain/status(packages/desktop/src/host/leo/brainGateway.ts)。 */
export type LeoBrainStatus = {
  enabled: boolean;
  cards: number | null;
  files: number | null;
  error?: string;
};

type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

type LeoBrainBridge = { brainStatus?: () => Promise<IpcResult<LeoBrainStatus>> };

function getBrainStatusReader(): (() => Promise<IpcResult<LeoBrainStatus>>) | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as unknown as { leoLink?: LeoBrainBridge }).leoLink;
  const brainStatus = bridge?.brainStatus;
  return brainStatus ? () => brainStatus() : null;
}

/**
 * [leo][G3] 首页「大脑」小卡:第二大脑里有多少卡片 / 文件。
 *
 * 数据由 Host 代问网关(key 只在 Host,界面拿不到);本机没发第二大脑 key 时整块不出现。
 * 读不到时一行说明 + 重试,不留空白。
 */
export function LeoHomeBrainCard({ className }: { className?: string }) {
  // 只取一次:每次渲染都新建函数会让下面的 effect 反复重跑。
  const [read] = useState(getBrainStatusReader);
  if (!read) return null;
  return <LeoHomeBrainCardBody read={read} className={className} />;
}

export function LeoHomeBrainCardBody({
  read,
  className,
}: {
  read: () => Promise<IpcResult<LeoBrainStatus>>;
  className?: string;
}) {
  const { intl, locale } = useZCodeIntl();
  const [status, setStatus] = useState<LeoBrainStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (): Promise<boolean> => {
    setLoading(true);
    try {
      const result = await read();
      // 出错时保留「本机有 key」的判断,只把数字清掉;还不知道有没有 key(Host 没起来)就继续不占位。
      setStatus((previous) =>
        result.ok
          ? result.data
          : previous
            ? { ...previous, cards: null, files: null, error: result.error }
            : null,
      );
      return result.ok;
    } catch {
      return false;
    } finally {
      setLoading(false);
    }
  }, [read]);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    // 刚启动时 Host 可能还没抢到端口:隔 5 秒再问,最多 6 次。
    const attempt = (left: number) =>
      void load().then((ok) => {
        if (alive && !ok && left > 0) timer = window.setTimeout(() => attempt(left - 1), 5_000);
      });
    attempt(6);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [load]);

  // 第一次结果回来之前、或本机没 key:不占位。
  if (!status || !status.enabled) return null;
  const failed = status.cards === null && status.files === null;

  return (
    <section
      aria-label={intl.formatMessage({ id: "leoHome.brain.title" })}
      data-testid="leo-home-brain"
      className={cn("leo-home-recent flex w-full max-w-2xl", className)}
    >
      <div className="flex min-w-0 items-center gap-2 rounded-xl border border-border bg-card px-3 py-2">
        <Brain aria-hidden="true" className="size-4 shrink-0 text-brand" />
        <span className="shrink-0 text-ui-caption font-medium text-foreground">
          {intl.formatMessage({ id: "leoHome.brain.title" })}
        </span>
        {failed ? (
          <>
            <span className="min-w-0 truncate text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "leoHome.brain.unreachable" })}
            </span>
            <Button type="button" variant="ghost" size="xs" disabled={loading} onClick={() => void load()}>
              {intl.formatMessage({ id: "leoHome.brain.retry" })}
            </Button>
          </>
        ) : (
          <span className="min-w-0 truncate text-ui-sm text-foreground-subtle tabular-nums">
            {intl.formatMessage(
              { id: "leoHome.brain.counts" },
              {
                cards: new Intl.NumberFormat(locale).format(status.cards ?? 0),
                files: new Intl.NumberFormat(locale).format(status.files ?? 0),
              },
            )}
          </span>
        )}
      </div>
    </section>
  );
}
