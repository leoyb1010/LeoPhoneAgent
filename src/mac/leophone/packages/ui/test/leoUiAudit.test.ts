import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { IPaperclipWorkspace, PaperclipSnapshot } from "@zcode/services";

import { PaperclipInspector } from "../src/paperclip/Inspector.js";

// 渲染审计回归：检查器的运行记录在 276px 侧栏里被两个按钮挤成一字一行；
// 审批申请者、运行执行者直接露出服务器内部 id。
function snapshot(): PaperclipSnapshot {
  return {
    generation: 1,
    origin: "https://server.example",
    user: { id: "u1", name: "Leo" },
    companyId: "c1",
    companies: [{ id: "c1", name: "公司" }],
    agents: [{ id: "ag_eng", companyId: "c1", name: "工程师", status: "running" }],
    issues: [],
    hasMore: false,
    selectedIssueId: "i1",
    busy: false,
    error: null,
    ready: true,
    log: null,
    receipts: {},
    detail: {
      issue: { id: "i1", companyId: "c1", title: "t", status: "todo", priority: "high" },
      comments: [],
      runs: [
        {
          runId: "run_with_a_quite_long_identifier_0123456789",
          agentId: "ag_eng",
          status: "running",
        },
      ],
      approvals: [
        {
          id: "ap1",
          companyId: "c1",
          type: "hire_agent",
          status: "pending",
          payload: { name: "设计师", budgetMonthlyCents: 5000 },
          requestedByAgentId: "ag_eng",
        },
      ],
      attachments: [],
    },
  };
}

test("检查器运行记录：状态与执行者名一行、编号一行、操作按钮单独一行", () => {
  const html = renderToStaticMarkup(
    createElement(PaperclipInspector, {
      service: {} as IPaperclipWorkspace,
      snapshot: snapshot(),
      invoke: async () => true,
      setDecision: () => undefined,
      notes: {},
      setNote: () => undefined,
    }),
  );
  assert.match(html, /运行中 ·\s*工程师/);
  assert.match(
    html,
    /<div class="flex flex-wrap gap-2"><button[^>]*>继续读取日志|<div class="flex flex-wrap gap-2"><button[^>]*>读取日志/,
  );
  assert.match(html, /申请者：\s*工程师/);
  assert.doesNotMatch(html, /申请者：\s*ag_eng/);
  assert.match(html, /聘用智能体/);
  assert.doesNotMatch(html, /代理/);
  // 审批内容按「字段 · 值」显示，原始 JSON 收在「展开原始内容」里。
  assert.match(html, /<dt[^>]*>名称<\/dt><dd[^>]*>设计师<\/dd>/);
  assert.match(html, /<summary[^>]*>展开原始内容<\/summary>/);
});

test("模型失败的英文兜底句按 code 本地化，带具体原因的消息保持原文", async () => {
  const { resolveChatErrorBannerDisplayMessage } = await import("../src/ChatErrorBanner.js");
  const intl = { formatMessage: ({ id }: { id: string }) => `[${id}]` } as never;
  const err = (message: string) =>
    ({ code: "model_request_failed", message }) as Parameters<
      typeof resolveChatErrorBannerDisplayMessage
    >[0];
  assert.equal(
    resolveChatErrorBannerDisplayMessage(err("Model request failed."), intl),
    "[chat.error.modelRequestFailed]",
  );
  assert.equal(
    resolveChatErrorBannerDisplayMessage(
      err("Network connection failed for the provider request."),
      intl,
    ),
    "[chat.error.modelNetworkFailed]",
  );
  assert.equal(
    resolveChatErrorBannerDisplayMessage(err("401 invalid api key"), intl),
    "401 invalid api key",
  );
});
