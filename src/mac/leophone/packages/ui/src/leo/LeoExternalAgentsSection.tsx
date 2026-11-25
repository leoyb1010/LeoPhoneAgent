import { CheckCircle2, CircleSlash, RefreshCw, SquareTerminal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

import {
  type AcpAgentListing,
  type AcpBridge,
  ClaudeTokenControl,
  SystemProxyToggle,
  WebLoginControl,
} from "./leoExternalAgentControls.js";

/**
 * [leo][WP-21] 设置「智能体 → 外部 agent」(macOS)。
 * Claude Code / Codex / Gemini / opencode 经 ACP 在 LeoBot 里开会话：新任务的模型选择里选「外部 Agent」即可。
 * 这里列出本机能不能用、用的是哪个 CLI；登录交给各家 CLI 自己（在「终端」里跑它们的登录命令），LeoBot 不经手凭据。
 */

function bridge(): AcpBridge | null {
  return (window as unknown as { leoAcp?: AcpBridge }).leoAcp ?? null;
}

export function LeoExternalAgentsSection() {
  const api = bridge();
  const { locale } = useZCodeIntl();
  const zh = (locale ?? "zh-CN").startsWith("zh");
  const [agents, setAgents] = useState<AcpAgentListing[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loginState, setLoginState] = useState<Record<string, "opened" | "failed">>({});
  const mountedRef = useRef(true);
  const epochRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      epochRef.current += 1;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!api) return;
    const myEpoch = ++epochRef.current;
    setLoading(true);
    try {
      const next = await api.list();
      if (!mountedRef.current || epochRef.current !== myEpoch) return;
      setAgents(next);
      setLoadError(null);
    } catch (error) {
      logger.warn("[LeoExternalAgentsSection] 读取外部 agent 失败", error);
      if (!mountedRef.current || epochRef.current !== myEpoch) return;
      setAgents([]);
      setLoadError(
        zh ? "读取外部 agent 列表失败，请重试。" : "Failed to inspect external agents. Please retry.",
      );
    } finally {
      if (mountedRef.current && epochRef.current === myEpoch) setLoading(false);
    }
  }, [api, zh]);

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
      if (!mountedRef.current) return;
      setLoginState((current) => ({ ...current, [agentId]: result.ok ? "opened" : "failed" }));
    },
    [api],
  );

  if (!api) {
    return (
      <p className="text-ui-base text-foreground-subtle">
        {zh ? "外部 agent 只在 macOS 桌面版可用。" : "External agents are only available in the macOS desktop app."}
      </p>
    );
  }

  return (
    <div className="space-y-4" data-testid="leo-external-agents-section">
      <p className="text-ui-base leading-6 text-foreground-subtle">
        {zh
          ? "在新任务的模型选择里选「外部 Agent」，就能直接用 Claude Code、Codex、Gemini、opencode 或 Grok 干活：改动、命令和审批和 LeoBot 自己的任务一样显示，手机上也能看到并审批。用的是你本机装好的 CLI 和它们自己的登录。"
          : "Pick External Agent in the model selector for a new task to run Claude Code, Codex, Gemini, opencode, or Grok directly. Edits, commands, and approvals show up identically here and on your phone, using your locally installed CLIs and logins."}
      </p>
      <div className="overflow-hidden rounded-xl border border-border">
        <div className="flex items-center justify-between bg-surface px-4 py-2.5 text-ui-sm text-foreground-subtle">
          <span>{zh ? "本机的外部 agent" : "Local external agents"}</span>
          <Button type="button" variant="ghost" size="sm" disabled={loading} onClick={() => void refresh()}>
            <RefreshCw
              aria-hidden="true"
              className={cn("mr-1.5 size-3.5", loading && "animate-spin motion-reduce:animate-none")}
            />
            {zh ? "重新检查" : "Re-check"}
          </Button>
        </div>
        {agents === null ? (
          <div className="border-t border-border px-4 py-3 text-ui-base text-foreground-subtle">
            {zh ? "正在检查…" : "Checking…"}
          </div>
        ) : loadError ? (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3 text-ui-sm text-destructive"
          >
            <span>{loadError}</span>
            <Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => void refresh()}>
              {zh ? "重试" : "Retry"}
            </Button>
          </div>
        ) : agents.length === 0 ? (
          <div className="border-t border-border px-4 py-3 text-ui-sm text-foreground-subtle">
            {zh ? "暂未检测到可用的外部 agent。" : "No external agents detected."}
          </div>
        ) : (
          agents.map((agent) => (
            <div
              key={agent.id}
              className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3 sm:flex-nowrap"
              data-acp-agent={agent.id}
            >
              {agent.available ? (
                <CheckCircle2 className="size-4 shrink-0 text-brand" aria-hidden="true" />
              ) : (
                <CircleSlash className="size-4 shrink-0 text-foreground-subtlest" aria-hidden="true" />
              )}
              <div className="min-w-0 flex-1">
                <div className="text-ui-base font-medium text-foreground">{agent.name}</div>
                <div className="truncate text-ui-sm text-foreground-subtle">
                  {agent.available
                    ? (agent.cliPath ?? (zh ? "可用" : "Available"))
                    : (agent.unavailableReason ?? (zh ? "这台 Mac 上不可用" : "Unavailable on this Mac"))}
                </div>
                {agent.available ? (
                  <div className="mt-1.5">
                    <WebLoginControl api={api} agentId={agent.id} onDone={() => void refresh()} />
                  </div>
                ) : null}
                {agent.id === "claude-code" && agent.available ? (
                  <div className="mt-1.5">
                    <ClaudeTokenControl
                      api={api}
                      configured={agent.longLivedToken === true}
                      onSaved={() => void refresh()}
                    />
                  </div>
                ) : null}
              </div>
              {agent.available && agent.loginCommand ? (
                <Button type="button" size="sm" variant="outline" onClick={() => void login(agent.id)}>
                  <SquareTerminal className="mr-1.5 size-3.5" aria-hidden="true" />
                  {loginState[agent.id] === "opened"
                    ? zh
                      ? "已在终端打开"
                      : "Opened in Terminal"
                    : loginState[agent.id] === "failed"
                      ? zh
                        ? "打开终端失败"
                        : "Failed to open Terminal"
                      : zh
                        ? "在终端登录"
                        : "Sign in in Terminal"}
                </Button>
              ) : null}
            </div>
          ))
        )}
        <SystemProxyToggle api={api} />
      </div>
    </div>
  );
}
