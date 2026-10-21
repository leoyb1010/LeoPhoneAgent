import { Smartphone, X } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/components/lib/utils.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";

import type { LeoLinkBridge, LinkStatus } from "./LeoPhoneLinkSection.js";

const DISMISS_KEY = "leo.home.phoneSetupCard.dismissed.v1";

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * [leo][up-home] 首页「连上你的 iPhone」引导卡。
 *
 * LeoBot 的 Mac 端最大的价值是「手机随时派活、批准、接管」，但以前要自己找到 设置 → 连接手机 才知道。
 * 只在：桌面端、中继已连上、还没有任何设备经直连授权 时出现；关掉就不再出现。
 */
export function LeoHomeSetupCard({ className }: { className?: string }) {
  const bridge = typeof window === "undefined" ? null : ((window as unknown as { leoLink?: LeoLinkBridge }).leoLink ?? null);
  const [status, setStatus] = useState<LinkStatus | null>(null);
  const [dismissed, setDismissed] = useState(readDismissed);
  const openSettingsTab = useOptionalTabStore((state) => state.openSettingsTab);

  useEffect(() => {
    if (!bridge || dismissed) return;
    let alive = true;
    // 刚启动时中继还在连：只读一次会一直显示「还没连上中继」。每 5 秒刷新，直到不再需要这张卡。
    const load = () =>
      void bridge
        .status()
        .then((result) => {
          if (alive && result.ok) setStatus(result.data);
        })
        .catch(() => undefined);
    load();
    const timer = window.setInterval(load, 5_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [bridge, dismissed]);

  if (!bridge || dismissed || !status) return null;
  const directDevices = status.direct?.devices.length ?? 0;
  if (!status.enabled || directDevices > 0) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // 不持久也没关系，这次会话不再显示
    }
  };

  return (
    <section
      aria-label="连上你的 iPhone"
      data-testid="leo-home-setup-card"
      className={cn(
        "leo-home-setup relative flex w-full max-w-2xl items-center gap-3 rounded-2xl border border-border bg-[var(--leo-card,var(--surface))] px-4 py-3",
        className,
      )}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[var(--leo-brand-soft)] text-[var(--leo-brand)]">
        <Smartphone className="size-4" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-ui-base font-medium text-foreground">连上你的 iPhone</div>
        <div className="text-ui-sm text-foreground-subtle">
          {status.connected
            ? "扫一次码，就能在手机上给这台 Mac 派任务、批准操作、看屏幕；同一网络下走加密直连。"
            : "这台 Mac 还没连上中继。打开「连接手机」看看原因，连上后扫码即可。"}
        </div>
      </div>
      <button
        type="button"
        onClick={() => {
          setPendingSettingsSectionIntent("phone");
          openSettingsTab?.();
        }}
        className="shrink-0 rounded-full bg-[var(--leo-brand)] px-3 py-1.5 text-ui-sm font-medium text-white transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--leo-brand)]"
      >
        扫码连接
      </button>
      <button
        type="button"
        aria-label="不再提示"
        onClick={dismiss}
        className="shrink-0 rounded-full p-1 text-foreground-subtlest transition-colors hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </section>
  );
}
