import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PaperclipWorkspace } from "../../packages/ui/src/paperclip/PaperclipWorkspace.js";
import { PaperclipTaskDetail } from "../../packages/ui/src/paperclip/PaperclipTaskDetail.js";
import { PaperclipReceiptBanner } from "../../packages/ui/src/paperclip/PaperclipReceiptBanner.js";

import { PaperclipTaskConfirmation } from "../../packages/ui/src/paperclip/PaperclipTaskConfirmation.js";

test("首次启动有中文配置与显式恢复入口，不提供Agent密钥或本地兜底", () => {
  const html = renderToStaticMarkup(
    <PaperclipWorkspace
      transport={{
        request: async () => ({ status: 401, data: null }),
        signIn: async () => ({ completed: false }),
        signOut: async () => {},
      }}
      persistence={{ getItem: () => null, setItem: () => {} }}
      onRecovery={() => {}}
    />,
  );
  for (const text of [
    "连接 Paperclip 服务器",
    "服务器名称",
    "服务器地址",
    "保存并连接",
    "本地恢复模式",
    "使用帮助",
  ])
    assert.ok(html.includes(text), text);
  assert.ok(!html.includes('type="password"'));
  assert.ok(!html.includes("<iframe"));
  assert.ok(!html.includes("<webview"));
});
test("任务详情提供中文状态、对话、运行、审批、成果与回复", () => {
  const html = renderToStaticMarkup(
    <PaperclipTaskDetail
      detail={{
        issue: { id: "i1", companyId: "c1", title: "示例任务", status: "todo" },
        comments: [],
        runs: [],
        approvals: [],
        documents: [],
        attachments: [],
        products: [],
      }}
      log={null}
      disabled={false}
      onCommand={async () => true}
      onLog={() => {}}
      onDownload={() => {}}
      onDocument={async () => null}
    />,
  );
  for (const text of [
    "任务状态",
    "对话",
    "运行与日志",
    "审批",
    "成果与附件",
    "回复任务",
    "发送回复",
  ])
    assert.ok(html.includes(text), text);
});
test("待核实操作有恢复与人工核实的可见入口", () => {
  const html = renderToStaticMarkup(
    <PaperclipReceiptBanner
      receipt={{
        id: "receipt-1",
        binding: { serverUrl: "https://example.com", companyId: "c1", userId: "u1" },
        command: { kind: "reply", issueId: "i1", body: "原回复" },
        createdAt: "2026-10-04T04:00:00Z",
        state: "uncertain",
      }}
      busy={false}
      onReconcile={() => {}}
      onAcknowledge={() => {}}
    />,
  );
  assert.ok(html.includes("核实结果"));
  assert.ok(html.includes("已人工核实"));
  assert.ok(html.includes("receipt-1"));
});

test("受阻确认框要求明确解除行动，空输入不能提交", () => {
  const html = renderToStaticMarkup(
    <PaperclipTaskConfirmation
      command={{ kind: "status", issueId: "i1", status: "blocked" }}
      issueTitle="示例任务"
      locked={false}
      submitting={false}
      onClose={() => {}}
      onConfirm={async () => {}}
    />,
  );
  assert.ok(html.includes('aria-label="解除受阻所需操作"'));
  assert.ok(html.includes('required=""'));
  assert.ok(html.includes('maxLength="2000"'));
  assert.ok(html.includes("解除受阻的责任人将设为当前登录账号"));
  assert.match(html, /<button[^>]*disabled=""[^>]*>确认提交<\/button>/);
});


test("评论作者依据明确身份展示，缺失或空白身份保持未知", () => {
  const cases = [
    { author: { authorUserId: "user-1" }, label: "用户" },
    { author: { authorAgentId: "agent-1" }, label: "智能体" },
    { author: { authorUserId: "user-1", authorAgentId: "agent-1" }, label: "用户" },
    { author: {}, label: "未知作者" },
    { author: { authorUserId: "", authorAgentId: "" }, label: "未知作者" },
    { author: { authorUserId: "  ", authorAgentId: "  " }, label: "未知作者" },
  ];
  for (const { author, label } of cases) {
    const html = renderToStaticMarkup(
      <PaperclipTaskDetail
        detail={{
          issue: { id: "i1", companyId: "c1", title: "示例任务", status: "todo" },
          comments: [{ id: "comment-1", companyId: "c1", issueId: "i1", body: "测试回复", ...author }],
          runs: [], approvals: [], documents: [], attachments: [], products: [],
        }}
        log={null}
        disabled={false}
        onCommand={async () => true}
        onLog={() => {}}
        onDownload={() => {}}
        onDocument={async () => null}
      />,
    );
    const comment = html.match(/<article[^>]*data-testid="paperclip-comment"[\s\S]*?<\/article>/)?.[0];
    assert.ok(comment, "存在评论容器");
    assert.match(comment, new RegExp(`>${label}<`));
    if (label !== "智能体") assert.ok(!comment.includes("智能体"));
  }
});
