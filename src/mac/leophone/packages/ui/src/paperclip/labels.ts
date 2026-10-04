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
export const paperclipIssueStatuses = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "blocked",
  "cancelled",
];
