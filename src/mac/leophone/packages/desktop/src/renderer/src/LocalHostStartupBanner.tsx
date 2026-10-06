import { useEffect, useState } from "react";
import { Button } from "@zcode/ui";
import {
  InternalChannels,
  databaseStartupStateSchema,
  type DatabaseStartupControl,
  type DatabaseStartupState,
} from "@zcode/shared";

/**
 * [leo] 服务器任务视图下的本机服务启动状态。
 *
 * 本机 Host(手机连接、藏宝阁、订阅代理、定时任务)在后台照常启动,但服务器视图不渲染本机的
 * 数据库启动页;Host 启动失败时这里给一条提示 + 重试,而不是静默地让这些能力全都不在。
 */
export function LocalHostStartupBanner({
  sendControl,
  onOpenLocal,
}: {
  sendControl: (control: DatabaseStartupControl) => void;
  onOpenLocal: () => void;
}) {
  const [failed, setFailed] = useState<DatabaseStartupState | null>(null);

  useEffect(() => {
    let latest: DatabaseStartupState | null = null;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window || event.data?.type !== InternalChannels.DatabaseStartupState)
        return;
      const result = databaseStartupStateSchema.safeParse(event.data.state);
      if (!result.success) return;
      const next = result.data;
      if (latest && next.startupId === latest.startupId && next.sequence <= latest.sequence) return;
      latest = next;
      setFailed(next.phase === "failed" ? next : null);
    };
    window.addEventListener("message", onMessage);
    // 主进程只在状态变化时推送;进来先要一次当前快照,错过的失败也能显示。
    sendControl({ action: "snapshot" });
    return () => window.removeEventListener("message", onMessage);
  }, [sendControl]);

  if (!failed) return null;
  return (
    <div
      role="alert"
      data-testid="local-host-startup-failed"
      className="fixed bottom-4 left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-wrap items-center gap-3 rounded-lg border border-border bg-popover px-4 py-3 text-ui-sm text-foreground shadow-lg"
    >
      <span className="min-w-0 flex-1">
        本机服务没有启动成功:手机连接、藏宝阁和定时任务暂时不可用。
      </span>
      <Button
        size="sm"
        variant="outline"
        onClick={() => sendControl({ action: "retry", attemptId: failed.attemptId })}
      >
        重试
      </Button>
      <Button size="sm" variant="ghost" onClick={onOpenLocal}>
        在本机工作台查看详情
      </Button>
    </div>
  );
}
