// [leo][WP-27] /api/leo/groups/* 的路由(httpApi.ts 已校验主钥匙;这里要求主进程内存口令已通过,否则 groups 为空)。
import { TaskGroupError, type LeoTaskGroups } from "./service.js";

const POST_ACTIONS = ["create", "diff", "merge", "cleanup"] as const;

export async function handleTaskGroupRequest(input: {
  /** 口令没过时传 undefined。 */
  groups: LeoTaskGroups | undefined;
  action: string;
  method: string | undefined;
  readBody: () => Promise<Record<string, unknown>>;
  send: (status: number, body: unknown) => void;
}): Promise<void> {
  const { groups, action, method, send } = input;
  if (!groups) {
    send(403, { error: "forbidden" });
    return;
  }
  try {
    if (action === "list" && method === "GET") {
      send(200, await groups.list());
      return;
    }
    const post = POST_ACTIONS.find((candidate) => candidate === action);
    if (post && method === "POST") {
      send(200, { result: await groups[post](await input.readBody()) });
      return;
    }
  } catch (error) {
    if (!(error instanceof TaskGroupError)) throw error;
    send(error.status, { error: error.message });
    return;
  }
  send(404, { error: "not found" });
}
