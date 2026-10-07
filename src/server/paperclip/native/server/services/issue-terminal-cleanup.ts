import { and, eq, sql } from "drizzle-orm";
import { agentWakeupRequests, type Db } from "@paperclipai/db";

/**
 * LeoPhoneAgent：任务进入已取消状态时，收尾仍在等待恢复的已保存消息（deferred_issue_execution 唤醒）。
 * 这些唤醒永远不会再被执行：唤醒队列在存在遗留恢复记录时直接放行，不会走到终态任务的取消分支；
 * 任务页则一直显示“N 条消息正在等待恢复处理”。保留审计行，只把状态改为 cancelled。
 */
export async function cancelDeferredIssueExecutionWakes(
  db: Db,
  input: { companyId: string; issueId: string; reason?: string },
): Promise<string[]> {
  const rows = await db
    .update(agentWakeupRequests)
    .set({ status: "cancelled", finishedAt: new Date(), error: input.reason ?? "issue_cancelled" })
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.status, "deferred_issue_execution"),
        sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`,
      ),
    )
    .returning({ id: agentWakeupRequests.id });
  return rows.map((row) => row.id);
}
