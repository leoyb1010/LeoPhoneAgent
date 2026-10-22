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

/**
 * [up-c-mac] 一次自动化运行已交给内核(sendPrompt 已 ACK)。Leo Link 据此盯住这个任务:
 * 无人值守时出的审批推给手机,30 分钟没人答就自动拒绝(docs/specs/leo-link-automations.md)。
 */
export type AutomationRunStarted = {
  automationId: string;
  runId: string;
  trigger: ZCodeAutomationTrigger;
  taskId: string;
  workspacePath: string;
  mode?: string;
};

type Listener<T> = (event: T) => void;
const completedListeners = new Set<Listener<AutomationRunCompleted>>();
const startedListeners = new Set<Listener<AutomationRunStarted>>();

/** 同一进程内广播;订阅方出错不影响运行记录和其它订阅方。 */
function publish<T>(listeners: Set<Listener<T>>, event: T): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // 推送是加分项,不能反过来打断自动化的终态处理。
    }
  }
}

function subscribe<T>(listeners: Set<Listener<T>>, listener: Listener<T>): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishAutomationRunCompleted(event: AutomationRunCompleted): void {
  publish(completedListeners, event);
}

export function onAutomationRunCompleted(listener: Listener<AutomationRunCompleted>): () => void {
  return subscribe(completedListeners, listener);
}

export function publishAutomationRunStarted(event: AutomationRunStarted): void {
  publish(startedListeners, event);
}

export function onAutomationRunStarted(listener: Listener<AutomationRunStarted>): () => void {
  return subscribe(startedListeners, listener);
}

/**
 * [up-c-mac] 运行结果的改判:Leo Link 自动拒绝了无人处理的审批并停掉运行后,
 * 内核报的终态是 stopped,但对用户来说这次运行是失败的(原因要能在手机上看到)。
 * Host 收终态时取走改判再回写运行记录 —— 运行记录仍只有 Host 一个写入方。
 */
const runFailures = new Map<string, string>();
const RUN_FAILURE_LIMIT = 100;

export function failAutomationRun(runId: string, reason: string): void {
  runFailures.delete(runId);
  runFailures.set(runId, reason);
  // 没等到终态的(派发后 Host 被关)不能无限攒着。
  while (runFailures.size > RUN_FAILURE_LIMIT) runFailures.delete(runFailures.keys().next().value!);
}

/** 取走并清掉某次运行的改判;没有就是 undefined(按内核终态)。 */
export function takeAutomationRunFailure(runId: string): string | undefined {
  const reason = runFailures.get(runId);
  runFailures.delete(runId);
  return reason;
}
