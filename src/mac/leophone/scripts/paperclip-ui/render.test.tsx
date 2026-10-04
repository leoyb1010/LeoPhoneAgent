import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PaperclipWorkspace } from "../../packages/ui/src/paperclip/PaperclipWorkspace.js";
import { PaperclipTaskDetail } from "../../packages/ui/src/paperclip/PaperclipTaskDetail.js";
import { PaperclipReceiptBanner } from "../../packages/ui/src/paperclip/PaperclipReceiptBanner.js";

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
