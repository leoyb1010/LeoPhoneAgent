import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button.js";
import { logger } from "@/logger.js";

/**
 * [leo] 设置 → 扩展 → MCP(用户级)顶部的「推荐：iMCP」卡片(WP-25)。
 * iMCP 是独立的菜单栏 App(mattt/iMCP,MIT),装了以后 agent 能读日历、提醒、通讯录、信息,跑快捷指令。
 * 装了就一键登记(走设置页「添加 MCP」同一条写入路径);没装就给出 Homebrew 命令,不替用户安装。
 */

type ImcpStatus =
  | { platform: "darwin"; installed: true; serverName: string; config: { command: string } }
  | { platform: "darwin"; installed: false; installCommand: string; appFound: boolean }
  | { platform: "other" };

function imcpBridge(): { status(): Promise<ImcpStatus> } | null {
  return (window as unknown as { leoImcp?: { status(): Promise<ImcpStatus> } }).leoImcp ?? null;
}

export function LeoImcpCard({
  registeredNames,
  onRegister,
}: {
  /** 当前用户级已登记的 MCP 名称;已有 imcp 时卡片不再出现。 */
  registeredNames: ReadonlySet<string>;
  onRegister: (name: string, config: { command: string }) => Promise<void>;
}) {
  const bridge = imcpBridge();
  const [status, setStatus] = useState<ImcpStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    const load = () =>
      bridge
        .status()
        .then((next) => {
          if (alive) setStatus(next);
        })
        .catch((error: unknown) => logger.warn("[LeoImcpCard] 查询 iMCP 失败", error));
    load();
    // 用户可能在终端里装完再切回来:窗口重新拿到焦点时再查一次。
    window.addEventListener("focus", load);
    return () => {
      alive = false;
      window.removeEventListener("focus", load);
    };
  }, [bridge]);

  if (!status || status.platform !== "darwin") return null;
  if (status.installed && registeredNames.has(status.serverName)) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3"
      data-testid="leo-imcp-card"
    >
      <div className="min-w-0 flex-1">
        <div className="text-ui-base font-medium text-foreground">推荐：iMCP</div>
        <div className="mt-0.5 text-ui-sm text-foreground-subtle">
          {status.installed
            ? "已检测到 iMCP。登记后 agent 可以读日历、提醒、通讯录和信息，运行快捷指令（首次使用时 iMCP 会请求系统授权）。"
            : status.appFound
              ? "这个版本的 iMCP 没有命令行组件，用下面的命令升级到最新版后再来登记。"
              : "装上 iMCP 菜单栏 App，agent 就能读日历、提醒、通讯录和信息，运行快捷指令。"}
        </div>
        {!status.installed ? (
          <code className="mt-2 inline-block rounded-md bg-surface px-2 py-1 font-mono text-ui-sm text-foreground select-text">
            {status.installCommand}
          </code>
        ) : null}
      </div>
      {status.installed ? (
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onRegister(status.serverName, status.config)
              .catch((error: unknown) => logger.warn("[LeoImcpCard] 登记 iMCP 失败", error))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "登记中…" : "一键添加"}
        </Button>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            void navigator.clipboard.writeText(status.installCommand).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <Check className="mr-1.5 size-3.5" /> : <Copy className="mr-1.5 size-3.5" />}
          {copied ? "已复制" : "复制命令"}
        </Button>
      )}
    </div>
  );
}
