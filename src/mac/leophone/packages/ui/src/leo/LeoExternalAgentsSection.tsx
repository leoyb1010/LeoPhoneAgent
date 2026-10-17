import { CheckCircle2, CircleSlash, RefreshCw, SquareTerminal } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { logger } from "@/logger.js";

/**
 * [leo][WP-21] 设置「智能体 → 外部 agent」(macOS)。
 * Claude Code / Codex / Gemini / opencode 经 ACP 在 LeoBot 里开会话：新任务的模型选择里选「外部 Agent」即可。
 * 这里列出本机能不能用、用的是哪个 CLI；登录交给各家 CLI 自己（在「终端」里跑它们的登录命令），LeoBot 不经手凭据。
 */

interface AcpAgentListing {
  id: string;
  name: string;
  available: boolean;
  cliPath?: string;
  unavailableReason?: string;
  loginCommand?: string;
}

interface AcpBridge {
  list(): Promise<AcpAgentListing[]>;
  login(agentId: string): Promise<{ ok: boolean }>;
}

function bridge(): AcpBridge | null {
  return (window as unknown as { leoAcp?: AcpBridge }).leoAcp ?? null;
}

export function LeoExternalAgentsSection() {
  const api = bridge();
  const [agents, setAgents] = useState<AcpAgentListing[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loginState, setLoginState] = useState<Record<string, "opened" | "failed">>({});

  const refresh = useCallback(async () => {
    if (!api) return;
    setLoading(true);
    try {
      setAgents(await api.list());
    } catch (error) {
      logger.warn("[LeoExternalAgentsSection] 读取外部 agent 失败", error);
      setAgents([]);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    // 用户去终端装好 / 登录完再切回来：窗口重新获得焦点时再查一次。
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const login = useCallback(
    async (agentId: string) => {
      if (!api) return;
      const result = await api.login(agentId).catch(() => ({ ok: false }));
      setLoginState((current) => ({ ...current, [agentId]: result.ok ? "opened" : "failed" }));
    },
    [api],
  );

  if (!api) {
    return <p className="text-ui-base text-foreground-subtle">外部 agent 只在 macOS 桌面版可用。</p>;
  }

  return (
    <div className="space-y-4" data-testid="leo-external-agents-section">
      <p className="text-ui-base leading-6 text-foreground-subtle">
        在新任务的模型选择里选「外部 Agent」，就能直接用 Claude Code、Codex、Gemini 或 opencode
        干活：改动、命令和审批和 LeoBot 自己的任务一样显示，手机上也能看到并审批。用的是你本机装好的
        CLI 和它们自己的登录。
      </p>
      <div className="overflow-hidden rounded-xl border border-border">
        <div className="flex items-center justify-between bg-surface px-4 py-2.5 text-ui-sm text-foreground-subtle">
          <span>本机的外部 agent</span>
          <Button type="button" variant="ghost" size="sm" disabled={loading} onClick={() => void refresh()}>
            <RefreshCw
              className={cn("mr-1.5 size-3.5", loading && "animate-spin motion-reduce:animate-none")}
            />
            重新检查
          </Button>
        </div>
        {agents === null ? (
          <div className="border-t border-border px-4 py-3 text-ui-base text-foreground-subtle">正在检查…</div>
        ) : (
          agents.map((agent) => (
            <div
              key={agent.id}
              className="flex items-center gap-3 border-t border-border px-4 py-3"
              data-acp-agent={agent.id}
            >
              {agent.available ? (
                <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden="true" />
              ) : (
                <CircleSlash className="size-4 shrink-0 text-foreground-subtlest" aria-hidden="true" />
              )}
              <div className="min-w-0 flex-1">
                <div className="text-ui-base font-medium text-foreground">{agent.name}</div>
                <div className="truncate text-ui-sm text-foreground-subtle">
                  {agent.available
                    ? (agent.cliPath ?? "可用")
                    : (agent.unavailableReason ?? "这台 Mac 上不可用")}
                </div>
              </div>
              {agent.available && agent.loginCommand ? (
                <Button type="button" size="sm" variant="outline" onClick={() => void login(agent.id)}>
                  <SquareTerminal className="mr-1.5 size-3.5" />
                  {loginState[agent.id] === "opened"
                    ? "已在终端打开"
                    : loginState[agent.id] === "failed"
                      ? "打开终端失败"
                      : "在终端登录"}
                </Button>
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
