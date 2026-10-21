import { CheckCircle2, ExternalLink, RefreshCw, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { logger } from "@/logger.js";

/**
 * [leo][WP-22] 设置「我的设备 → 电脑操作」(macOS)。
 * Agent 通过随包 Peekaboo 登记的 MCP `leo-screen` 看屏、点按、输入;这里展示 `peekaboo permissions status --json`
 * 的三项权限,缺哪项就给一个直达系统设置对应面板的按钮。macOS 27 读不到 TCC.db,状态只能这样问。
 */

type PermissionKey = "screen-recording" | "accessibility" | "event-synthesizing";

interface Permission {
  key: PermissionKey;
  name: string;
  required: boolean;
  granted: boolean;
  instructions: string;
}

type Status =
  | { state: "ok"; version: string | null; permissions: Permission[]; source: string | null }
  | { state: "missing" }
  | { state: "error"; message: string };

interface ComputerUseBridge {
  status(): Promise<Status>;
  openSettings(key: PermissionKey): Promise<boolean>;
  relaunch?(): Promise<boolean>;
}

const LABELS: Record<PermissionKey, { title: string; detail: string; where: string }> = {
  "screen-recording": {
    title: "屏幕录制",
    detail: "截图、识别界面元素（see）",
    where: "系统设置 › 隐私与安全性 › 屏幕与系统录音，打开 LeoBot",
  },
  accessibility: {
    title: "辅助功能",
    detail: "点按、输入、读取界面结构",
    where: "系统设置 › 隐私与安全性 › 辅助功能，打开 LeoBot",
  },
  "event-synthesizing": {
    title: "合成键盘鼠标事件",
    detail: "部分 App 的键盘快捷键（可选）",
    where: "系统设置 › 隐私与安全性 › 辅助功能（与上一项同一处）",
  },
};

function bridge(): ComputerUseBridge | null {
  return (window as unknown as { leoComputerUse?: ComputerUseBridge }).leoComputerUse ?? null;
}

export function LeoComputerUseSection() {
  const api = bridge();
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!api) return;
    setLoading(true);
    try {
      setStatus(await api.status());
    } catch (error) {
      logger.warn("[LeoComputerUseSection] 读取权限失败", error);
      setStatus({
        state: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    // 用户去系统设置勾完权限再切回来:窗口重新获得焦点时再查一次。
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  if (!api) {
    return <p className="text-ui-base text-foreground-subtle">电脑操作只在 macOS 桌面版可用。</p>;
  }

  return (
    <div className="space-y-4" data-testid="leo-computer-use-section">
      <p className="text-ui-base leading-6 text-foreground-subtle">
        允许后，Agent 可以看屏幕、点按和输入；在后台操作，不抢你的鼠标。授权给 LeoBot
        本身，改完回到这里会自动刷新。
      </p>
      <details className="text-ui-sm text-foreground-subtlest">
        <summary className="cursor-pointer select-none">技术细节</summary>
        <p className="mt-1 leading-5">
          通过随包的 Peekaboo{status?.state === "ok" && status.version ? ` ${status.version}` : ""}，以 MCP 服务「leo-screen」的形式提供给 Agent。
        </p>
      </details>
      <div className="overflow-hidden rounded-xl border border-border">
        <div className="flex items-center justify-between bg-surface px-4 py-2.5 text-ui-sm text-foreground-subtle">
          <span>
            权限
            {status?.state === "ok"
              ? ` · ${status.permissions.some((p) => p.required && !p.granted) ? "还差几项" : "已就绪"}`
              : ""}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={loading}
            onClick={() => void refresh()}
          >
            <RefreshCw
              className={cn(
                "mr-1.5 size-3.5",
                loading && "animate-spin motion-reduce:animate-none",
              )}
            />
            重新检查
          </Button>
        </div>
        {status === null ? (
          <div className="border-t border-border px-4 py-3 text-ui-base text-foreground-subtle">
            正在检查…
          </div>
        ) : status.state === "missing" ? (
          <div className="border-t border-border px-4 py-3 text-ui-base text-foreground-subtle">
            这个版本没有带 Peekaboo（开发环境请先运行{" "}
            <code className="font-mono">pnpm leo:fetch-peekaboo</code>）。
          </div>
        ) : status.state === "error" ? (
          <div
            role="alert"
            className="border-t border-border px-4 py-3 text-ui-base text-destructive"
          >
            读不到权限状态：{status.message}
          </div>
        ) : (
          status.permissions.map((permission) => (
            <div
              key={permission.key}
              className="flex items-center gap-3 border-t border-border px-4 py-3"
              data-permission={permission.key}
            >
              {permission.granted ? (
                <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden="true" />
              ) : (
                <TriangleAlert
                  className={cn(
                    "size-4 shrink-0",
                    permission.required
                      ? "text-[var(--leo-attention)]"
                      : "text-foreground-subtlest",
                  )}
                  aria-hidden="true"
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-ui-base font-medium text-foreground">
                  {LABELS[permission.key].title}
                  {permission.required ? "" : "（可选）"}
                  {/* 状态要有文字：只靠图标颜色，读屏和色弱用户都分不出来。 */}
                  <span
                    className={cn(
                      "rounded-full px-1.5 py-px text-ui-xs font-normal",
                      permission.granted
                        ? "bg-success/10 text-success"
                        : permission.required
                          ? "bg-[color-mix(in_srgb,var(--leo-attention)_14%,transparent)] text-[var(--leo-attention)]"
                          : "bg-muted text-foreground-subtle",
                    )}
                  >
                    {permission.granted ? "已允许" : "未允许"}
                  </span>
                </div>
                <div className="text-ui-sm text-foreground-subtle">
                  {permission.granted ? LABELS[permission.key].detail : LABELS[permission.key].where}
                </div>
              </div>
              {permission.granted ? null : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-label={`${LABELS[permission.key].title}：未允许，去系统设置开启`}
                  onClick={() => void api.openSettings(permission.key)}
                >
                  去系统设置
                  <ExternalLink className="ml-1.5 size-3.5" />
                </Button>
              )}
            </div>
          ))
        )}
      </div>
      {status?.state === "ok" && status.permissions.some((p) => !p.granted) ? (
        <div className="flex items-center justify-between gap-3 rounded-xl bg-surface px-4 py-3 text-ui-sm text-foreground-subtle">
          <span>
            在系统设置里已经打开了？屏幕录制要重启 LeoBot 才生效；辅助功能如果打开了仍显示未允许，先在列表里用「−」删掉
            LeoBot 再重新添加 /Applications/LeoBot.app（升级后旧条目可能失效）。
          </span>
          {api.relaunch ? (
            <Button type="button" size="sm" variant="outline" onClick={() => void api.relaunch?.()}>
              重启 LeoBot
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
