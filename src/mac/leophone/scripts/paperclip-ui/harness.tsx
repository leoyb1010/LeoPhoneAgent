import React from "react";
import { createRoot } from "react-dom/client";
import { PaperclipWorkspace } from "../../packages/ui/src/paperclip/PaperclipWorkspace.js";
import type { PaperclipTransport } from "../../packages/services/src/paperclip/contract.js";
import "../../packages/ui/src/styles.css";
const issue = {
  id: "issue-1",
  companyId: "company-1",
  identifier: "LEO-1",
  title: "验证原生任务工作区",
  description: "这是一项来自服务器的测试任务",
  status: "todo",
};
const runs = [
  {
    id: "run-1",
    agentId: "agent-1",
    companyId: "company-1",
    status: "running",
    agentName: "中文智能体",
  },
];
const approvals = [
  {
    id: "approval-1",
    companyId: "company-1",
    type: "hire_agent",
    status: "pending",
    payload: { name: "新的智能体" },
  },
];
const comments: unknown[] = [];
let loggedIn = false;
let loseReceipt = false;
let posts = 0;
Object.assign(window, {
  paperclipHarness: {
    get posts() {
      return posts;
    },
    loseNextReceipt() {
      loseReceipt = true;
    },
  },
});
const transport: PaperclipTransport = {
  signIn: async () => {
    loggedIn = true;
    return { completed: true };
  },
  signOut: async () => {
    loggedIn = false;
  },
  download: async () => {
    document.body.dataset.downloaded = "true";
  },
  request: async ({ path, method, body }) => {
    const p = path.split("?")[0];
    if (p === "/api/health")
      return { status: 200, data: { status: "ok", deploymentMode: "authenticated" } };
    if (p === "/api/auth/get-session")
      return { status: 200, data: loggedIn ? { user: { id: "user-1", name: "测试用户" } } : null };
    if (!loggedIn) return { status: 401, data: null };
    if (method !== "GET") posts++;
    if (loseReceipt && method !== "GET") {
      loseReceipt = false;
      throw new Error("测试：回执丢失");
    }
    let data: unknown = [];
    if (p === "/api/companies") data = [{ id: "company-1", name: "中文测试组织" }];
    if (p === "/api/companies/company-1/agents")
      data = [{ id: "agent-1", companyId: "company-1", name: "中文智能体", status: "idle" }];
    if (p === "/api/companies/company-1/issues")
      data = method === "POST" ? { ...issue, title: (body as { title: string }).title } : [issue];
    if (p === "/api/issues/issue-1") {
      if (method === "PATCH") Object.assign(issue, body);
      data = issue;
    }
    if (p === "/api/issues/issue-1/comments") {
      if (method === "POST") {
        const comment = {
          id: `comment-${posts}`,
          companyId: "company-1",
          issueId: "issue-1",
          ...(body as object),
          authorUserId: "user-1",
        };
        comments.push(comment);
        data = comment;
      } else data = comments;
    }
    if (p === "/api/issues/issue-1/runs") data = runs.map((r) => ({ ...r, runId: r.id }));
    if (p === "/api/issues/issue-1/live-runs") data = runs;
    if (p === "/api/issues/issue-1/approvals") data = approvals;
    if (p === "/api/approvals/approval-1") data = approvals[0];
    if (p === "/api/approvals/approval-1/approve") {
      approvals[0]!.status = "approved";
      data = approvals[0];
    }
    if (p === "/api/heartbeat-runs/run-1/log")
      data = { runId: "run-1", content: "服务器已开始处理任务\n", nextOffset: 38 };
    if (p === "/api/heartbeat-runs/run-1/cancel") runs[0]!.status = "cancelled";
    if (p === "/api/heartbeat-runs/run-1") data = runs[0];
    if (p === "/api/issues/issue-1/documents")
      data = [
        {
          id: "doc-1",
          issueId: issue.id,
          companyId: issue.companyId,
          key: "plan",
          title: "工作计划",
        },
      ];
    if (p === "/api/issues/issue-1/documents/plan")
      data = {
        issueId: issue.id,
        companyId: issue.companyId,
        key: "plan",
        body: "这是服务器上的中文文档正文",
      };
    if (p === "/api/issues/issue-1/attachments")
      data = [
        {
          id: "file-1",
          issueId: issue.id,
          companyId: issue.companyId,
          originalFilename: "任务结果.txt",
        },
      ];
    return { status: 200, data };
  },
};
createRoot(document.getElementById("root")!).render(
  <PaperclipWorkspace
    transport={transport}
    persistence={localStorage}
    onRecovery={() => {
      document.body.dataset.recovery = "true";
    }}
  />,
);
