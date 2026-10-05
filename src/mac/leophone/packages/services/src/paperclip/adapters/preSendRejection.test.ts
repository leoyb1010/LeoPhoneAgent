import assert from "node:assert/strict";
import { test } from "node:test";
import type { NativePaperclipPort } from "@zcode/shared";
import { createPaperclipWorkspace } from "./createWorkspace.js";
import { creationRetryPermitted } from "../contract.js";

// 发送前被拒（busy / 未知回执阻塞 / 创建重试窗口）必须发布 rejected 回执且不发出任何写请求，
// UI 才能回滚 submitted 并保留草稿；已发出后的未知结果保持 unknown。
type Reply = { status: number; data: unknown };
const issue = { id: "a-issue", companyId: "a", title: "任务", status: "todo", priority: "medium" };
function fixture(hold?: (input: Parameters<NativePaperclipPort["request"]>[0]) => boolean) {
  const writes: string[] = [];
  let release: (() => void) | null = null;
  const port: NativePaperclipPort = {
    getPreferences: async () => ({ origin: "", companies: {} }),
    setPreferences: async () => {},
    signIn: async () => ({ completed: true }),
    signOut: async () => {},
    download: async () => {},
    request: async (input): Promise<Reply> => {
      if (input.method !== "GET") writes.push(input.path);
      if (hold?.(input)) await new Promise<void>((resolve) => (release = resolve));
      if (input.method === "POST") throw new Error("connection lost");
      const path = input.path.split("?")[0]!;
      const data =
        path === "/api/health"
          ? { status: "ok", deploymentMode: "authenticated" }
          : path === "/api/auth/get-session"
            ? { user: { id: "human" } }
            : path === "/api/companies"
              ? [{ id: "a", name: "公司甲" }]
              : path.endsWith("/issues")
                ? [issue]
                : path.endsWith("/agents") ||
                    path.endsWith("/comments") ||
                    path.endsWith("/runs") ||
                    path.endsWith("/approvals") ||
                    path.endsWith("/attachments")
                  ? []
                  : issue;
      return { status: 200, data };
    },
  };
  return { workspace: createPaperclipWorkspace(port), writes, release: () => release?.() };
}
const create = (requestId: string, firstSubmittedAt = Date.now(), retry = false) =>
  ({ kind: "create", requestId, firstSubmittedAt, retry, title: "任务", description: "" }) as const;

test("a command refused while busy publishes a rejected receipt and sends nothing", async () => {
  let holding = false;
  const item = fixture((input) => holding && input.path.includes("/issues?"));
  await item.workspace.configure("https://example.com");
  holding = true;
  const refresh = item.workspace.refresh();
  assert.equal(item.workspace.getSnapshot().busy, true);
  await assert.rejects(item.workspace.command(create("busy-request")), /正在同步/);
  assert.equal(item.workspace.getSnapshot().receipts["busy-request"]?.state, "rejected");
  holding = false;
  item.release();
  await refresh;
  assert.deepEqual(item.writes, []);
});

test("a new write blocked by another unknown receipt is rejected, the unknown stays unknown", async () => {
  const item = fixture();
  await item.workspace.configure("https://example.com");
  await assert.rejects(item.workspace.command(create("lost")));
  assert.equal(item.workspace.getSnapshot().receipts.lost?.state, "unknown");
  await assert.rejects(
    item.workspace.command({
      kind: "comment",
      requestId: "reply",
      retry: false,
      issueId: "a-issue",
      body: "补充",
    }),
    /原提交结果未知/,
  );
  const receipts = item.workspace.getSnapshot().receipts;
  assert.equal(receipts.reply?.state, "rejected");
  assert.equal(receipts.lost?.state, "unknown");
  assert.equal(item.writes.length, 1, "only the original create was ever sent");
});

test("a create outside the retry window is rejected before sending", async () => {
  const item = fixture();
  await item.workspace.configure("https://example.com");
  await assert.rejects(
    item.workspace.command(create("stale", Date.now() - 6 * 86_400_000)),
    /6 天重试窗口/,
  );
  assert.equal(item.workspace.getSnapshot().receipts.stale?.state, "rejected");
  assert.deepEqual(item.writes, []);
});

test("a refused retry of an unknown submission never rewrites it as rejected", async () => {
  let holding = false;
  const item = fixture((input) => holding && input.path.includes("/issues?"));
  await item.workspace.configure("https://example.com");
  await assert.rejects(item.workspace.command(create("lost")));
  holding = true;
  const refresh = item.workspace.refresh();
  await assert.rejects(item.workspace.command(create("lost", Date.now(), true)), /正在同步/);
  assert.equal(item.workspace.getSnapshot().receipts.lost?.state, "unknown");
  holding = false;
  item.release();
  await refresh;
});

test("the client retry window is six days, one day inside the server's seven-day retention", () => {
  const now = 10 * 86_400_000;
  assert.equal(creationRetryPermitted(now - 6 * 86_400_000 + 1, now), true);
  assert.equal(creationRetryPermitted(now - 6 * 86_400_000, now), false);
  assert.equal(creationRetryPermitted(now + 1, now), false);
  assert.equal(creationRetryPermitted(Number.NaN, now), false);
});
