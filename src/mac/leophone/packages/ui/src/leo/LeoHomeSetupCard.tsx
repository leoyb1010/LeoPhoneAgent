import { Smartphone, X } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
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
  const { intl } = useZCodeIntl();

  const needsSetupCard = status === null || (status.enabled && (status.direct?.devices.length ?? 0) === 0);

  useEffect(() => {
    if (!bridge || dismissed || !needsSetupCard) return;
    let alive = true;
    // 刚启动时中继还在连：每 5 秒刷新；一旦已配对设备或功能停用，立即停止轮询，后台切隐藏时暂停。
    const load = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      void bridge
        .status()
        .then((result) => {
          if (alive && result.ok) setStatus(result.data);
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 5_000);
    const onVisibilityChange = () => {
      if (typeof document !== "undefined" && !document.hidden) load();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }
    return () => {
      alive = false;
      window.clearInterval(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    };
  }, [bridge, dismissed, needsSetupCard]);

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

  const title = intl.formatMessage({ id: "leoHome.phone.title" });
  return (
    <section
      aria-label={title}
      data-testid="leo-home-setup-card"
      className={cn(
        // [G3] 只用设计 token:卡片 bg-card / rounded-xl,主操作用共享 Button(青绿 primary)。
        "leo-home-setup relative flex w-full max-w-2xl items-center gap-3 rounded-xl border border-border bg-card px-4 py-3",
        className,
      )}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-brand">
        <Smartphone className="size-4" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-ui-base font-medium text-foreground">{title}</div>
        <div className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({
            id: status.connected ? "leoHome.phone.connected" : "leoHome.phone.relayDown",
          })}
        </div>
      </div>
      <Button
        type="button"
        size="sm"
        onClick={() => {
          setPendingSettingsSectionIntent("phone");
          openSettingsTab?.();
        }}
      >
        {intl.formatMessage({ id: "leoHome.phone.scan" })}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={intl.formatMessage({ id: "leoHome.phone.dismiss" })}
        onClick={dismiss}
        className="text-foreground-subtlest hover:text-foreground"
      >
        <X className="size-3.5" />
      </Button>
    </section>
  );
}
