import type { ZCodeAutomationRunOutcome, ZCodeAutomationTrigger } from "@zcode/shared";

/**
 * [up-p3-mac] 一次自动化运行走到终态(docs/specs/leo-link-automations.md)。
 * 由 Host 的 trackCronRunOutcome 在回写运行记录之后发布;Leo Link 订阅后推给手机。
 */
export type AutomationRunCompleted = {
  automationId: string;
  runId: string;
  trigger: ZCodeAutomationTrigger;
  outcome: Exclude<ZCodeAutomationRunOutcome, "running">;
  error?: string;
  taskId: string;
  workspacePath: string;
};

type Listener = (event: AutomationRunCompleted) => void;
const listeners = new Set<Listener>();

/** 同一进程内广播;订阅方出错不影响运行记录和其它订阅方。 */
export function publishAutomationRunCompleted(event: AutomationRunCompleted): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // 推送是加分项,不能反过来打断自动化的终态处理。
    }
  }
}

export function onAutomationRunCompleted(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
