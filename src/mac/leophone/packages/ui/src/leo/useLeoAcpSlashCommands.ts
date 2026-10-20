import { useEffect, useRef, useState } from "react";
import type { ZCodeSlashCommand } from "@zcode/shared";
import { ACP_PROVIDER_ID, isAcpAgentId, type AcpAgentCommand } from "@zcode/shared/acp";

/**
 * [leo][WP-21] 外部 agent（ACP）会话的 `/` 面板：列 agent 自己广播的命令（available_commands_update，
 * CLI 落盘、主进程读取），而不是 LeoBot 的命令。不是外部 agent 会话时返回 undefined（面板照旧）。
 */
const REFRESH_MS = 10_000;

interface AcpCommandsBridge {
  commands?(agentId: string, cwd: string): Promise<AcpAgentCommand[]>;
}

export function acpAgentIdOf(config: { provider?: string; model?: string } | null | undefined): string | null {
  return config?.provider === ACP_PROVIDER_ID && isAcpAgentId(config.model) ? config.model : null;
}

export function toAcpSlashCommands(commands: readonly AcpAgentCommand[]): ZCodeSlashCommand[] {
  const seen = new Set<string>();
  return commands.flatMap((command) => {
    const name = command.name.replace(/^\//, "").trim();
    if (!name || seen.has(name)) return [];
    seen.add(name);
    return [
      {
        name,
        description: command.description,
        ...(command.inputHint ? { inputHint: command.inputHint } : {}),
        source: "custom" as const,
      },
    ];
  });
}

export function sameSlashCommands(a: readonly ZCodeSlashCommand[], b: readonly ZCodeSlashCommand[]): boolean {
  return a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
}

export function useLeoAcpSlashCommands(
  agentId: string | null,
  workspacePath: string,
): ZCodeSlashCommand[] | undefined {
  const [commands, setCommandsState] = useState<ZCodeSlashCommand[]>([]);
  const current = useRef(commands);
  // 内容没变就不 setState：以前每 10 秒无条件 setState，近 4000 行的 SessionPane 跟着重渲。
  // 用 ref 比较而不是函数式 setState，后者 React 仍会先把组件本身再渲染一遍才放弃。
  const setCommands = (next: ZCodeSlashCommand[]) => {
    if (sameSlashCommands(current.current, next)) return;
    current.current = next;
    setCommandsState(next);
  };
  useEffect(() => {
    const bridge =
      typeof window === "undefined" ? undefined : (window as unknown as { leoAcp?: AcpCommandsBridge }).leoAcp;
    if (!agentId || !bridge?.commands) {
      setCommands([]);
      return;
    }
    let cancelled = false;
    // agent 在会话开始后才广播命令：会话开着时隔一会儿、窗口回到前台时再读一次。
    const load = () =>
      void bridge.commands!(agentId, workspacePath)
        .then((next) => {
          if (cancelled) return;
          setCommands(toAcpSlashCommands(next));
        })
        .catch(() => undefined);
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    window.addEventListener("focus", load);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [agentId, workspacePath]);
  return agentId ? commands : undefined;
}
