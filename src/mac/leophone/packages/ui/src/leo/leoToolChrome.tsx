import { useNowTicker } from "@/components/workflow-graph/use-now-ticker.js";

/**
 * [leo][wp-31] 工具卡统一骨架的两件小东西:左侧状态条的状态,和标题行右侧的耗时。
 * 状态条本身画在 leo-skin.css 的 [data-leo-tool-state]::before 上,这里只给出状态。
 */
export type LeoToolChromeState = "running" | "success" | "failed";

/** ToolCallBlock 的 legacy 状态(pending / in_progress / completed / failed / stopped / denied)→ 状态条。 */
export function resolveLeoToolChromeState(status: string, isRunning: boolean): LeoToolChromeState {
  if (isRunning) return "running";
  if (status === "failed" || status === "stopped" || status === "denied") return "failed";
  return "success";
}

/** 耗时文案:<10s 保留一位小数,<60s 取整秒,再往上 分+秒。负数或非有限值不显示。 */
export function formatLeoToolElapsed(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 10_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
}

export function LeoToolElapsed({
  startedAt,
  endedAt,
  running,
}: {
  startedAt?: number;
  endedAt?: number;
  running: boolean;
}) {
  // 只有在跑且有起点时才走秒表;结束态用 endedAt 定格,没有 endedAt 就不显示(不拿"现在"冒充结束时间)。
  const now = useNowTicker(running && typeof startedAt === "number");
  if (typeof startedAt !== "number") return null;
  const end = running ? now : endedAt;
  if (typeof end !== "number") return null;
  const label = formatLeoToolElapsed(end - startedAt);
  if (!label) return null;
  return (
    <span
      className="leo-tool-elapsed text-ui-sm tabular-nums text-foreground-subtlest"
      data-testid="leo-tool-elapsed"
    >
      {label}
    </span>
  );
}

export function hasLeoToolElapsed(
  startedAt: number | undefined,
  endedAt: number | undefined,
  running: boolean,
): boolean {
  return typeof startedAt === "number" && (running || typeof endedAt === "number");
}
