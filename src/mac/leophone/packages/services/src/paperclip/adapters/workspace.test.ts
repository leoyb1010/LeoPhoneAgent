import assert from "node:assert/strict";
import { test } from "node:test";
import type { NativePaperclipPort } from "@zcode/shared";
import { createPaperclipWorkspace } from "./createWorkspace.js";
import { paperclipApprovalFingerprint } from "../domain/approval.js";

type Reply = { status: number; data: unknown };
const issue = (companyId: string, id = `${companyId}-issue`) => ({
  id,
  companyId,
  title: "任务",
  status: "todo",
  priority: "medium",
});
function fixture(
  override?: (
    input: Parameters<NativePaperclipPort["request"]>[0],
  ) => Promise<Reply | undefined> | undefined,
) {
  let writes = 0;
  let downloads = 0;
  const preferences = { origin: "", companies: {} };
  const port: NativePaperclipPort = {
    getPreferences: async () => preferences,
    setPreferences: async () => {},
    signIn: async () => ({ completed: true }),
    signOut: async () => {},
    download: async () => {
      downloads++;
    },
    request: async (input) => {
      if (input.method !== "GET") writes++;
      const custom = await override?.(input);
      if (custom) return custom;
      const path = input.path.split("?")[0];
      if (!path) throw new Error("测试请求必须包含非空 API 路径。");
      const company = path.includes("/companies/b/") || path.includes("/issues/b-") ? "b" : "a";
      const data =
        path === "/api/health"
          ? { status: "ok", deploymentMode: "authenticated" }
          : path === "/api/auth/get-session"
            ? { user: { id: "human", name: "测试用户" } }
            : path === "/api/companies"
              ? [
                  { id: "a", name: "公司甲" },
                  { id: "b", name: "公司乙" },
                ]
              : path.endsWith("/comments") ||
                  path.endsWith("/runs") ||
                  path.endsWith("/approvals") ||
                  path.endsWith("/attachments") ||
                  path.endsWith("/agents")
                ? []
                : path.includes("/companies/")
                  ? [issue(company)]
                  : issue(company);
      return { status: 200, data };
    },
  };
  return {
    workspace: createPaperclipWorkspace(port),
    writes: () => writes,
    downloads: () => downloads,
  };
}
function deferred() {
  let resolve!: (reply: Reply) => void;
  const promise = new Promise<Reply>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
test("late reads cannot replace a newly selected company's projection", async () => {
  const pending = deferred();
  let hold = false;
  const { workspace } = fixture((input) =>
    hold && input.path.startsWith("/api/companies/a/issues") ? pending.promise : undefined,
  );
  await workspace.configure("https://example.com");
  hold = true;
  const old = workspace.refresh();
  await workspace.selectCompany("b");
  pending.resolve({ status: 200, data: [issue("a")] });
  await old;
  assert.equal(workspace.getSnapshot().companyId, "b");
  assert.equal(workspace.getSnapshot().issues[0]?.companyId, "b");
});
test("logout revokes the publication right of an in-flight read", async () => {
  const pending = deferred();
  let hold = false;
  const { workspace } = fixture((input) =>
    hold && input.path.includes("/companies/a/issues") ? pending.promise : undefined,
  );
  await workspace.configure("https://example.com");
  hold = true;
  const old = workspace.refresh();
  await workspace.signOut();
  pending.resolve({ status: 200, data: [issue("a")] });
  await old;
  assert.equal(workspace.getSnapshot().user, null);
  assert.deepEqual(workspace.getSnapshot().issues, []);
});
test("a lost mutation response stays unknown and refresh never retries the write", async () => {
  const item = fixture((input) =>
    input.method === "POST" ? Promise.reject(new Error("connection lost")) : undefined,
  );
  await item.workspace.configure("https://example.com");
  await assert.rejects(
    item.workspace.command({
      kind: "create",
      requestId: "request",
      firstSubmittedAt: Date.now(),
      retry: false,
      title: "任务",
      description: "",
    }),
  );
  assert.equal(item.workspace.getSnapshot().receipts.request?.state, "unknown");
  await item.workspace.refresh();
  assert.equal(item.writes(), 1);
  await assert.rejects(
    item.workspace.command({
      kind: "create",
      requestId: "request",
      firstSubmittedAt: Date.now(),
      retry: false,
      title: "任务",
      description: "",
    }),
  );
  assert.equal(item.writes(), 1);
});
test("creation replay stays inside the six-day client window (server keeps keys 7 days)", async () => {
  const item = fixture();
  await item.workspace.configure("https://example.com");
  for (const firstSubmittedAt of [NaN, Date.now() - 6 * 86400000, Date.now() + 100000]) {
    await assert.rejects(
      item.workspace.command({
        kind: "create",
        requestId: "request",
        firstSubmittedAt,
        retry: true,
        title: "任务",
        description: "",
      }),
    );
  }
  assert.equal(item.writes(), 0);
});
test("a successful HTTP response without a valid receipt is unknown", async () => {
  const item = fixture((input) =>
    input.method === "POST" ? Promise.resolve({ status: 200, data: {} }) : undefined,
  );
  await item.workspace.configure("https://example.com");
  await assert.rejects(
    item.workspace.command({
      kind: "create",
      requestId: "request",
      firstSubmittedAt: Date.now(),
      retry: false,
      title: "任务",
      description: "",
    }),
  );
  assert.equal(item.workspace.getSnapshot().receipts.request?.state, "unknown");
});
test("downloads derive their path from the current task's freshly read attachment list", async () => {
  const item = fixture((input) =>
    input.path.endsWith("/attachments")
      ? Promise.resolve({
          status: 200,
          data: [
            {
              id: "attachment",
              assetId: "asset",
              companyId: "a",
              issueId: "a-issue",
              byteSize: 1,
              contentPath: "https://other.example/content",
            },
          ],
        })
      : undefined,
  );
  await item.workspace.configure("https://example.com");
  await item.workspace.selectIssue("a-issue");
  await assert.rejects(item.workspace.downloadAttachment("attachment"));
  assert.equal(item.downloads(), 0);
});
test("a 401 clears old identity and company data", async () => {
  let expired = false;
  const { workspace } = fixture((input) =>
    expired && input.path.includes("/issues?")
      ? Promise.resolve({ status: 401, data: null })
      : undefined,
  );
  await workspace.configure("https://example.com");
  expired = true;
  await assert.rejects(workspace.refresh());
  assert.equal(workspace.getSnapshot().user, null);
  assert.deepEqual(workspace.getSnapshot().issues, []);
});
test("human operator commands compose into a task, decision, run and attachment workflow", async () => {
  let status = "todo";
  let unblockDescriptor: unknown;
  let approved = false;
  let cancelled = false;
  const comments: unknown[] = [];
  const currentIssue = () => ({ ...issue("a"), status, unblockDescriptor });
  const approval = () => ({
    id: "approval",
    companyId: "a",
    type: "hire_agent",
    status: approved ? "approved" : "pending",
    payload: {},
  });
  const item = fixture(async (input) => {
    const path = input.path.split("?")[0];
    if (input.method !== "GET") assert.equal(input.expectedUserId, "human");
    if (path === "/api/companies/a/issues")
      return { status: 200, data: input.method === "POST" ? currentIssue() : [currentIssue()] };
    if (path === "/api/issues/a-issue") {
      if (input.method === "PATCH") {
        status = (input.body as { status: string }).status;
        unblockDescriptor = (input.body as { unblockDescriptor?: unknown }).unblockDescriptor;
      }
      return { status: 200, data: currentIssue() };
    }
    if (path === "/api/issues/a-issue/comments") {
      if (input.method === "POST")
        comments.push({
          id: "comment",
          companyId: "a",
          issueId: "a-issue",
          authorUserId: "human",
          authorAgentId: null,
          createdAt: "2026-10-04T06:00:00Z",
          ...(input.body as object),
        });
      return { status: 200, data: input.method === "POST" ? comments[0] : comments };
    }
    if (path === "/api/issues/a-issue/approvals") return { status: 200, data: [approval()] };
    if (path === "/api/approvals/approval") return { status: 200, data: approval() };
    if (path === "/api/approvals/approval/approve") {
      approved = true;
      return { status: 200, data: approval() };
    }
    if (path === "/api/issues/a-issue/runs")
      return {
        status: 200,
        data: [{ runId: "run", agentId: "agent", status: cancelled ? "cancelled" : "running" }],
      };
    if (path === "/api/heartbeat-runs/run")
      return {
        status: 200,
        data: { id: "run", companyId: "a", status: cancelled ? "cancelled" : "running" },
      };
    if (path === "/api/heartbeat-runs/run/log")
      return { status: 200, data: { runId: "run", content: "fixture log", nextOffset: 11 } };
    if (path === "/api/heartbeat-runs/run/cancel") {
      cancelled = true;
      return { status: 200, data: { id: "run", status: "cancelled" } };
    }
    if (path === "/api/issues/a-issue/attachments")
      return {
        status: 200,
        data: [
          {
            id: "attachment",
            assetId: "asset",
            companyId: "a",
            issueId: "a-issue",
            byteSize: 1,
            contentPath: "/api/attachments/attachment/content",
          },
        ],
      };
    return undefined;
  });
  // 未命中的路由沿用官方形状的基础 fixture，而非给每项功能另建状态源。
  await item.workspace.configure("https://example.com");
  await item.workspace.command({
    kind: "create",
    requestId: "create",
    firstSubmittedAt: Date.now(),
    retry: false,
    title: "任务",
    description: "",
  });
  await item.workspace.command({
    kind: "comment",
    requestId: "reply",
    retry: false,
    issueId: "a-issue",
    body: "补充要求",
  });
  await item.workspace.command({
    kind: "status",
    issueId: "a-issue",
    status: "blocked",
    unblockAction: "测试用户确认需求后继续",
  });
  await item.workspace.command({
    kind: "approval",
    issueId: "a-issue",
    approvalId: "approval",
    approve: true,
    note: "已核对",
    expectedApproval: paperclipApprovalFingerprint(approval()),
  });
  await item.workspace.readLog("run");
  await item.workspace.command({ kind: "cancel", issueId: "a-issue", runId: "run" });
  await item.workspace.downloadAttachment("attachment");
  assert.equal(item.workspace.getSnapshot().detail?.comments[0]?.body, "补充要求");
  assert.equal(item.workspace.getSnapshot().detail?.comments[0]?.authorUserId, "human");
  assert.equal(item.workspace.getSnapshot().detail?.comments[0]?.authorAgentId, null);
  assert.equal(item.workspace.getSnapshot().detail?.comments[0]?.createdAt, "2026-10-04T06:00:00Z");
  assert.equal(item.workspace.getSnapshot().detail?.issue.status, "blocked");
  assert.equal(item.workspace.getSnapshot().detail?.approvals[0]?.status, "approved");
  assert.equal(item.workspace.getSnapshot().detail?.runs[0]?.status, "cancelled");
  assert.equal(item.workspace.getSnapshot().log?.content, "fixture log");
  assert.equal(item.writes(), 5);
  assert.equal(item.downloads(), 1);
});
