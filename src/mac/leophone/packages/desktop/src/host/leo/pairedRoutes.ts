// [leo] 只有主进程能调的 Host 接口:菜单栏 / 快速派发(/api/leo/quick/*)与并行任务组(/api/leo/groups/*)。
// httpApi.ts 已校验主钥匙;这里还要主进程内存里的口令(paired)。主钥匙文件本机进程都读得到,
// 只凭它就能派任务的话,一个被注入的 agent 可以自己给自己开新任务。
import { QuickDispatchError, type LeoQuickEntry } from "./quickEntry.js";
import { TaskGroupError, type LeoTaskGroups } from "./taskGroups/service.js";

const GROUP_POST_ACTIONS = ["create", "diff", "merge", "cleanup"] as const;

export function isPairedLeoRoute(pathname: string): boolean {
  return pathname.startsWith("/api/leo/quick/") || pathname.startsWith("/api/leo/groups/");
}

export async function handlePairedLeoRoute(input: {
  pathname: string;
  method: string | undefined;
  paired: boolean;
  quick: LeoQuickEntry | undefined;
  groups: LeoTaskGroups | undefined;
  readBody: () => Promise<Record<string, unknown>>;
  send: (status: number, body: unknown) => void;
}): Promise<void> {
  const { pathname, method, send } = input;
  const quick = pathname.startsWith("/api/leo/quick/");
  if (!input.paired || (quick ? !input.quick : !input.groups)) {
    send(403, { error: "forbidden" });
    return;
  }
  try {
    if (quick) {
      if (pathname === "/api/leo/quick/summary" && method === "GET") return send(200, await input.quick!.summary());
      if (pathname === "/api/leo/quick/dispatch" && method === "POST")
        return send(202, await input.quick!.dispatch(await input.readBody()));
    } else {
      const action = pathname.slice("/api/leo/groups/".length);
      if (action === "list" && method === "GET") return send(200, await input.groups!.list());
      const post = GROUP_POST_ACTIONS.find((candidate) => candidate === action);
      if (post && method === "POST") return send(200, { result: await input.groups![post](await input.readBody()) });
    }
  } catch (error) {
    if (!(error instanceof QuickDispatchError) && !(error instanceof TaskGroupError)) throw error;
    send(error.status, { error: error.message });
    return;
  }
  send(404, { error: "not found" });
}
