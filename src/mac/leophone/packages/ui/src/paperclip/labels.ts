import { PAPERCLIP_ISSUE_PRIORITIES } from "@zcode/shared";

export function paperclipStatus(value: string): string {
  return (
    (
      {
        backlog: "待规划",
        todo: "待处理",
        in_progress: "进行中",
        in_review: "待审核",
        done: "已完成",
        blocked: "受阻",
        cancelled: "已取消",
        queued: "排队中",
        running: "运行中",
        succeeded: "运行成功",
        failed: "运行失败",
        timed_out: "运行超时",
        pending: "待审批",
        approved: "已批准",
        rejected: "已拒绝",
        revision_requested: "要求修改",
      } as Record<string, string>
    )[value] ?? "未知状态"
  );
}
// 优先级枚举来自 @zcode/shared 协议真相源（与服务器 994d6edc 一致）。服务器优先级是 critical/high/medium/low；旧版误用 urgent，导致最高优先级显示为原始英文。
const priorityLabels: Record<(typeof PAPERCLIP_ISSUE_PRIORITIES)[number], string> = {
  critical: "紧急",
  high: "高",
  medium: "中",
  low: "低",
};
export function paperclipPriority(value: string): string {
  return (PAPERCLIP_ISSUE_PRIORITIES as readonly string[]).includes(value)
    ? priorityLabels[value as keyof typeof priorityLabels]
    : value;
}
