import assert from "node:assert/strict";
import test from "node:test";
import {
  PaperclipWorkspaceService,
  canonicalPaperclipServer,
  paperclipLabel,
  paperclipApprovalFingerprint,
  type PaperclipPersistence,
  type PaperclipTransport,
} from "../src/paperclip/contract.js";
const issue = {
  id: "issue-1",
  companyId: "company-1",
  title: "测试任务",
  description: "验证服务端契约",
  status: "todo",
};
const agent = { id: "agent-1", companyId: "company-1", name: "执行者", status: "idle" };
const approval = {
  id: "approval-1",
  companyId: "company-1",
  type: "hire_agent",
  status: "pending",
  payload: { name: "新执行者" },
};
const run = { id: "run-1", companyId: "company-1", agentId: "agent-1", status: "running" };
function memory(): PaperclipPersistence {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
}
function fixture(storage = memory()) {
  const calls: Parameters<PaperclipTransport["request"]>[0][] = [];
  const mutations: typeof calls = [];
  let userId = "user-1";
  let intercept:
    | ((input: (typeof calls)[number]) => Promise<{ status: number; data: unknown } | undefined>)
    | null = null;
  const transport: PaperclipTransport = {
    signIn: async () => ({ completed: true }),
    signOut: async () => {},
    download: async () => {},
    request: async (input) => {
      calls.push(input);
      if (input.method !== "GET") mutations.push(input);
      const overridden = await intercept?.(input);
      if (overridden) return overridden;
      const path = input.path.split("?")[0];
      let data: unknown;
      if (path === "/api/auth/get-session") data = { user: { id: userId, name: "测试用户" } };
      else if (path === "/api/companies") data = [{ id: "company-1", name: "测试公司" }];
      else if (path === "/api/companies/company-1/agents") data = [agent];
      else if (path === "/api/companies/company-1/issues")
        data = input.method === "POST" ? issue : [issue];
      else if (path === "/api/issues/issue-1")
        data = input.method === "PATCH" ? { ...issue, ...(input.body as object) } : issue;
      else if (path === "/api/issues/issue-1/comments")
        data =
          input.method === "POST"
            ? {
                id: "comment-1",
                issueId: issue.id,
                companyId: issue.companyId,
                ...(input.body as object),
              }
            : [];
      else if (path === "/api/issues/issue-1/runs")
        data = [{ runId: run.id, agentId: run.agentId, status: "running" }];
      else if (path === "/api/issues/issue-1/live-runs") data = [run];
      else if (path === "/api/issues/issue-1/approvals") data = [approval];
      else if (path === "/api/issues/issue-1/documents")
        data = [
          {
            id: "doc-1",
            companyId: issue.companyId,
            issueId: issue.id,
            key: "plan",
            title: "计划",
          },
        ];
      else if (path === "/api/issues/issue-1/documents/plan")
        data = { companyId: issue.companyId, issueId: issue.id, key: "plan", body: "中文正文" };
      else if (path === "/api/issues/issue-1/attachments")
        data = [
          {
            id: "file-1",
            companyId: issue.companyId,
            issueId: issue.id,
            originalFilename: "结果.txt",
          },
        ];
      else if (path === "/api/issues/issue-1/work-products") data = [];
      else if (path === "/api/heartbeat-runs/run-1/log")
        data = {
          runId: run.id,
          content: "日志\n",
          nextOffset: Number(new URL(`https://test${input.path}`).searchParams.get("offset")) + 7,
        };
      else if (path === "/api/heartbeat-runs/run-1/cancel") data = undefined;
      else if (path === "/api/heartbeat-runs/run-1") data = { ...run, status: "cancelled" };
      else if (path === "/api/approvals/approval-1") data = approval;
      else if (path === "/api/approvals/approval-1/approve")
        data = { ...approval, status: "approved" };
      else throw new Error(`测试不允许未知路径 ${path}`);
      return { status: 200, data };
    },
  };
  const service = new PaperclipWorkspaceService(
    transport,
    storage,
    () => "00000000-0000-4000-8000-000000000001",
  );
  const connect = async () => {
    await service.configure({ serverUrl: "https://server.example", name: "测试" });
    await service.selectCompany("company-1");
    await service.selectIssue("issue-1");
  };
  return {
    service,
    transport,
    storage,
    calls,
    mutations,
    connect,
    setUser: (id: string) => {
      userId = id;
    },
    intercept: (fn: typeof intercept) => {
      intercept = fn;
    },
  };
}

test("源地址只允许安全 origin，拒绝凭据、路径、远端 HTTP", () => {
  assert.equal(canonicalPaperclipServer(" https://server.example/ "), "https://server.example");
  assert.equal(canonicalPaperclipServer("http://localhost:3100"), "http://localhost:3100");
  for (const url of [
    "http://server.example",
    "https://u:p@server.example",
    "https://server.example/api",
    "file:///tmp/x",
    "https://server.example?token=secret",
  ])
    assert.throws(() => canonicalPaperclipServer(url));
});
test("连接必须选择授权公司；历史 runId 与活跃 id 正确合并", async () => {
  const f = fixture();
  await f.connect();
  assert.equal(f.service.getSnapshot().binding?.userId, "user-1");
  assert.deepEqual(
    f.service.getSnapshot().detail?.runs.map((r) => r.id),
    ["run-1"],
  );
  assert.ok(f.calls.some((c) => c.path === "/api/companies?scope=accessible"));
  await f.service.selectCompany("unauthorized");
  assert.equal(f.service.getSnapshot().binding?.companyId, "company-1");
});
test("创建提交上游 idempotencyKey、执行者和 todo，而非把 task 当 run", async () => {
  const f = fixture();
  await f.connect();
  assert.equal(
    await f.service.mutate({
      kind: "create",
      title: "新任务",
      description: "详情",
      agentId: "agent-1",
    }),
    true,
  );
  assert.deepEqual(f.mutations[0]?.body, {
    title: "新任务",
    description: "详情",
    assigneeAgentId: "agent-1",
    status: "todo",
    idempotencyKey: "00000000-0000-4000-8000-000000000001",
  });
});
test("回复带 UUID 回执，连续点击仅一次 mutation", async () => {
  const f = fixture();
  await f.connect();
  const command = { kind: "reply" as const, issueId: "issue-1", body: "补充要求" };
  const results = await Promise.all([f.service.mutate(command), f.service.mutate(command)]);
  assert.deepEqual(results, [true, false]);
  assert.equal(f.mutations.length, 1);
  assert.equal(
    (f.mutations[0]!.body as Record<string, unknown>).clientRequestId,
    "00000000-0000-4000-8000-000000000001",
  );
});
test("提交超时不清草稿回执、不自动重发，核实复用原 body/key", async () => {
  const f = fixture();
  await f.connect();
  let first = true;
  f.intercept(async (input) => {
    if (input.method === "POST" && first) {
      first = false;
      throw new Error("lost receipt");
    }
    return undefined;
  });
  assert.equal(
    await f.service.mutate({ kind: "reply", issueId: "issue-1", body: "只发一次" }),
    false,
  );
  assert.equal(f.service.getSnapshot().receipt?.state, "uncertain");
  await f.service.refresh();
  assert.equal(f.mutations.length, 1);
  assert.equal(
    await f.service.mutate({ kind: "reply", issueId: "issue-1", body: "另一次" }),
    false,
  );
  await f.service.reconcile();
  assert.equal(f.mutations.length, 2);
  assert.deepEqual(f.mutations[0]?.body, f.mutations[1]?.body);
  assert.equal(f.service.getSnapshot().receipt, null);
});
test("重新启动保留不确定创建，恢复使用相同幂等键", async () => {
  const f = fixture();
  await f.connect();
  f.intercept(async (input) => (input.method === "POST" ? { status: 503, data: null } : undefined));
  await f.service.mutate({
    kind: "create",
    title: "保留任务",
    description: "",
    agentId: "agent-1",
  });
  const next = fixture(f.storage);
  await next.connect();
  assert.equal(next.service.getSnapshot().receipt?.command.kind, "create");
  await next.service.reconcile();
  assert.equal(next.service.getSnapshot().receipt, null);
  assert.deepEqual(next.mutations[0]?.body, f.mutations[0]?.body);
});
test("错误成功回执视为不确定，不展示假成功", async () => {
  const f = fixture();
  await f.connect();
  f.intercept(async (input) =>
    input.method === "POST" ? { status: 200, data: "<html>login</html>" } : undefined,
  );
  await f.service.mutate({ kind: "reply", issueId: "issue-1", body: "你好" });
  assert.equal(f.service.getSnapshot().receipt?.state, "uncertain");
});
test("状态更新未知结果仅 GET 读回，不重复 PATCH", async () => {
  const f = fixture();
  await f.connect();
  let patched = false;
  f.intercept(async (input) => {
    if (input.method === "PATCH") {
      patched = true;
      throw new Error("timeout");
    }
    if (patched && input.path === "/api/issues/issue-1")
      return { status: 200, data: { ...issue, status: "done" } };
    return undefined;
  });
  await f.service.mutate({ kind: "status", issueId: "issue-1", status: "done" });
  await f.service.reconcile();
  assert.equal(f.mutations.length, 1);
  assert.equal(f.service.getSnapshot().receipt, null);
});
test("核实时 403 不证明之前未提交，继续保留回执", async () => {
  const f = fixture();
  await f.connect();
  f.intercept(async (input) =>
    input.method === "PATCH" ? { status: 503, data: null } : undefined,
  );
  await f.service.mutate({ kind: "status", issueId: "issue-1", status: "done" });
  f.intercept(async (input) =>
    input.path === "/api/issues/issue-1" ? { status: 403, data: null } : undefined,
  );
  await f.service.reconcile();
  assert.ok(f.service.getSnapshot().receipt);
});
test("切换 human session 后不向原任务发送变更", async () => {
  const f = fixture();
  await f.connect();
  f.setUser("user-2");
  assert.equal(
    await f.service.mutate({ kind: "reply", issueId: "issue-1", body: "不该发送" }),
    false,
  );
  assert.equal(f.mutations.length, 0);
  assert.match(f.service.getSnapshot().error!, /账号已变化/);
  await f.service.refresh();
  assert.equal(f.service.getSnapshot().binding, null);
  assert.equal(f.service.getSnapshot().detail, null);
});
test("刷新失败保留只读快照，禁止离线提交", async () => {
  const f = fixture();
  await f.connect();
  f.intercept(async () => {
    throw new Error("offline");
  });
  await f.service.refresh();
  assert.equal(f.service.getSnapshot().connection, "offline");
  assert.equal(f.service.getSnapshot().issues.length, 1);
  assert.equal(
    await f.service.mutate({ kind: "reply", issueId: "issue-1", body: "不可离线执行" }),
    false,
  );
  assert.equal(f.mutations.length, 0);
});
test("取消运行严格以 run ID 提交，并读回终态", async () => {
  const f = fixture();
  await f.connect();
  assert.equal(
    await f.service.mutate({ kind: "cancel", issueId: "issue-1", runId: "run-1" }),
    true,
  );
  assert.equal(f.mutations[0]?.path, "/api/heartbeat-runs/run-1/cancel");
  assert.equal(
    await f.service.mutate({ kind: "cancel", issueId: "issue-1", runId: "issue-1" }),
    false,
  );
});
test("审批只允许当前任务关联 pending ID", async () => {
  const f = fixture();
  await f.connect();
  assert.equal(
    await f.service.mutate({
      kind: "approve",
      issueId: "issue-1",
      approvalId: "stranger",
      expectedApproval: paperclipApprovalFingerprint(approval),
      decisionNote: "",
    }),
    false,
  );
  assert.equal(f.mutations.length, 0);
  assert.equal(
    await f.service.mutate({
      kind: "approve",
      issueId: "issue-1",
      approvalId: "approval-1",
      expectedApproval: paperclipApprovalFingerprint(approval),
      decisionNote: "已核对",
    }),
    true,
  );
  assert.equal(f.mutations[0]?.path, "/api/approvals/approval-1/approve");
});
test("日志增量 offset、只允许关联运行、文档返回正文", async () => {
  const f = fixture();
  await f.connect();
  await f.service.loadLog("stranger");
  await f.service.loadLog("run-1");
  await f.service.loadLog("run-1");
  assert.equal(f.service.getSnapshot().log?.content, "日志\n日志\n");
  assert.ok(f.calls.some((c) => c.path.includes("/run-1/log?offset=7")));
  assert.equal(await f.service.readDocument("plan"), "中文正文");
  assert.equal(await f.service.readDocument("unknown"), null);
});
test("服务器返回其他公司的任务时 fail closed", async () => {
  const f = fixture();
  await f.connect();
  f.intercept(async (input) =>
    input.path === "/api/issues/issue-1"
      ? { status: 200, data: { ...issue, companyId: "company-other" } }
      : undefined,
  );
  await f.service.selectIssue("issue-1");
  assert.equal(f.service.getSnapshot().detail, null);
  assert.match(f.service.getSnapshot().error!, /其他公司/);
});
test("保存回执失败必须在任何远端写入之前中止", async () => {
  const storage = memory();
  const f = fixture({
    getItem: (key) => storage.getItem(key),
    setItem: (key, value) => {
      if (key.includes("receipts")) throw new Error("disk full");
      storage.setItem(key, value);
    },
  });
  await f.connect();
  assert.equal(
    await f.service.mutate({ kind: "reply", issueId: "issue-1", body: "不要丢失" }),
    false,
  );
  assert.equal(f.mutations.length, 0);
});
test("中文状态与未知状态兜底", () => {
  assert.equal(paperclipLabel("running"), "运行中");
  assert.equal(paperclipLabel("future_status"), "其他状态");
});

test("超过安全窗口的创建回执禁止重放，避免七天上游幂等记录过期后重复创建", async () => {
  const f = fixture();
  await f.connect();
  f.intercept(async (input) => (input.method === "POST" ? { status: 503, data: null } : undefined));
  await f.service.mutate({ kind: "create", title: "旧任务", description: "", agentId: "agent-1" });
  const key = "leophone.paperclip.receipts.v1";
  const receipts = JSON.parse(f.storage.getItem(key)!);
  receipts[0].createdAt = new Date(Date.now() - 7 * 86400000).toISOString();
  f.storage.setItem(key, JSON.stringify(receipts));
  const next = fixture(f.storage);
  await next.connect();
  await next.service.reconcile();
  assert.equal(next.mutations.length, 0);
  assert.ok(next.service.getSnapshot().receipt);
  assert.match(next.service.getSnapshot().error!, /超过安全核实期限/);
});
test("旧服务器的迟到刷新不得覆盖新服务器身份和数据", async () => {
  const f = fixture();
  await f.connect();
  let release!: (value: { status: number; data: unknown }) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.intercept(async (input) => {
    if (input.serverUrl === "https://server.example" && input.path.startsWith("/api/companies?")) {
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    }
    return undefined;
  });
  const old = f.service.refresh();
  await started;
  await f.service.configure({ serverUrl: "https://new.example", name: "新服务器" });
  release({ status: 200, data: [{ id: "old-company", name: "旧公司" }] });
  await old;
  assert.equal(f.service.getSnapshot().profile?.serverUrl, "https://new.example");
  assert.equal(f.service.getSnapshot().binding, null);
  assert.equal(f.service.getSnapshot().companies[0]?.id, "company-1");
});

test("审批内容在用户确认后变化时中止，不发出任何审批决定", async () => {
  const f = fixture();
  await f.connect();
  f.intercept(async (input) =>
    input.path === "/api/approvals/approval-1"
      ? { status: 200, data: { ...approval, payload: { name: "不同的执行者", dangerous: true } } }
      : undefined,
  );
  const ok = await f.service.mutate({
    kind: "approve",
    issueId: "issue-1",
    approvalId: "approval-1",
    expectedApproval: paperclipApprovalFingerprint(approval),
    decisionNote: "已核对",
  });
  assert.equal(ok, false);
  assert.equal(f.mutations.length, 0);
  assert.equal(f.service.getSnapshot().receipt, null);
  assert.match(f.service.getSnapshot().error!, /审批内容已变化/);
});
test("人工核实解除阻塞保留原回执，重启不重放、不再次阻塞", async () => {
  const f = fixture();
  await f.connect();
  f.intercept(async (input) => (input.method === "POST" ? { status: 503, data: null } : undefined));
  await f.service.mutate({ kind: "reply", issueId: "issue-1", body: "人工核对的原内容" });
  f.service.acknowledgeReceipt();
  assert.equal(f.service.getSnapshot().receipt, null);
  assert.equal(f.mutations.length, 1);
  const saved = JSON.parse(f.storage.getItem("leophone.paperclip.receipts.v1")!);
  assert.equal(saved[0].state, "acknowledged");
  assert.equal(saved[0].command.body, "人工核对的原内容");
  const next = fixture(f.storage);
  await next.connect();
  assert.equal(next.service.getSnapshot().receipt, null);
  await next.service.reconcile();
  assert.equal(next.mutations.length, 0);
});
test("缺失、非法或未来的创建时间禁止自动重放", async () => {
  for (const createdAt of [undefined, "not-a-date", new Date(Date.now() + 3600000).toISOString()]) {
    const f = fixture();
    await f.connect();
    f.intercept(async (input) =>
      input.method === "POST" ? { status: 503, data: null } : undefined,
    );
    await f.service.mutate({
      kind: "create",
      title: "时间异常",
      description: "",
      agentId: "agent-1",
    });
    const key = "leophone.paperclip.receipts.v1";
    const saved = JSON.parse(f.storage.getItem(key)!);
    saved[0].createdAt = createdAt;
    f.storage.setItem(key, JSON.stringify(saved));
    const next = fixture(f.storage);
    await next.connect();
    await next.service.reconcile();
    assert.equal(next.mutations.length, 0);
  }
});
