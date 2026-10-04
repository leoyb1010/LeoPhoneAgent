import assert from "node:assert/strict";
import { test } from "node:test";
import type { NativePaperclipPort, PaperclipPreferences } from "@zcode/shared";
import { createPaperclipWorkspace } from "./createWorkspace.js";
type Input = Parameters<NativePaperclipPort["request"]>[0];
function fixture(override: (input: Input) => unknown) {
  let prefs: PaperclipPreferences = { origin: "", companies: {} };
  const writes: Input[] = [];
  let logins = 0;
  const issue = {
    id: "issue",
    companyId: "company",
    title: "任务",
    status: "todo",
    priority: "medium",
  };
  const port: NativePaperclipPort = {
    getPreferences: async () => prefs,
    setPreferences: async (v) => {
      prefs = structuredClone(v);
    },
    signIn: async () => {
      logins++;
      return { completed: true };
    },
    signOut: async () => {},
    download: async () => {},
    request: async (input) => {
      if (input.path === "/api/health") assert.equal(input.expectedUserId, undefined);
      if (input.method !== "GET") writes.push(input);
      const custom = override(input);
      if (custom instanceof Error) throw custom;
      if (custom !== undefined) return { status: 200, data: custom };
      const path = input.path.split("?")[0];
      const data =
        path === "/api/health"
          ? { status: "ok", deploymentMode: "authenticated" }
          : path === "/api/auth/get-session"
            ? { user: { id: "human" } }
            : path === "/api/companies"
              ? [{ id: "company", name: "组织" }]
              : path === "/api/companies/company/issues"
                ? [issue]
                : path === "/api/issues/issue"
                  ? issue
                  : [];
      return { status: 200, data };
    },
  };
  return { service: createPaperclipWorkspace(port), writes, logins: () => logins };
}
test("health authReady false blocks login", async () => {
  const item = fixture((i) =>
    i.path === "/api/health"
      ? { status: "ok", deploymentMode: "authenticated", authReady: false }
      : undefined,
  );
  await assert.rejects(item.service.configure("https://example.com"));
  await assert.rejects(item.service.signIn());
  assert.equal(item.logins(), 0);
});
test("blocked requires explicit action and precise bound owner receipt", async () => {
  const item = fixture((i) =>
    i.method === "PATCH"
      ? {
          id: "issue",
          companyId: "company",
          title: "任务",
          status: "blocked",
          priority: "medium",
          unblockDescriptor: { owner: { userId: "other" }, action: "等待我完成" },
        }
      : undefined,
  );
  await item.service.configure("https://example.com");
  await item.service.selectIssue("issue");
  await assert.rejects(
    item.service.command({ kind: "status", issueId: "issue", status: "blocked" }),
  );
  assert.equal(item.writes.length, 0);
  await assert.rejects(
    item.service.command({
      kind: "status",
      issueId: "issue",
      status: "blocked",
      unblockAction: " 等待我完成 ",
    }),
  );
  assert.deepEqual(item.writes[0]?.body, {
    status: "blocked",
    unblockDescriptor: { owner: { userId: "human" }, action: "等待我完成" },
  });
  assert.equal(Object.values(item.service.getSnapshot().receipts)[0]?.state, "unknown");
});
test("unknown blocked reconciliation only GET reads exact expectation", async () => {
  let sent = false;
  const item = fixture((i) => {
    if (i.method === "PATCH") {
      sent = true;
      return new Error("lost");
    }
    if (sent && i.path === "/api/issues/issue")
      return {
        id: "issue",
        companyId: "company",
        title: "任务",
        status: "blocked",
        priority: "medium",
        unblockDescriptor: { owner: { userId: "human" }, action: "确认需求" },
      };
    return undefined;
  });
  await item.service.configure("https://example.com");
  await item.service.selectIssue("issue");
  await assert.rejects(
    item.service.command({
      kind: "status",
      issueId: "issue",
      status: "blocked",
      unblockAction: "确认需求",
    }),
  );
  const id = Object.values(item.service.getSnapshot().receipts)[0]!.id;
  await item.service.command({ kind: "reconcile", receiptId: id });
  assert.equal(item.writes.length, 1);
  assert.equal(item.service.getSnapshot().receipts[id]?.state, "confirmed");
});
test("reply mismatched body or author remains unknown", async () => {
  const item = fixture((i) =>
    i.method === "POST"
      ? {
          id: "comment",
          issueId: "issue",
          companyId: "company",
          body: "different",
          authorUserId: "other",
          clientRequestId: "reply",
        }
      : undefined,
  );
  await item.service.configure("https://example.com");
  await item.service.selectIssue("issue");
  await assert.rejects(
    item.service.command({
      kind: "comment",
      issueId: "issue",
      requestId: "reply",
      retry: false,
      body: "original",
    }),
  );
  assert.equal(item.service.getSnapshot().receipts.reply?.state, "unknown");
});
test("null cancellation is confirmed by bound GET run", async () => {
  let cancelled = false;
  const item = fixture((i) => {
    if (i.path.endsWith("/runs"))
      return [{ runId: "run", agentId: "agent", status: cancelled ? "cancelled" : "running" }];
    if (i.path.endsWith("/cancel")) {
      cancelled = true;
      return null;
    }
    if (i.path === "/api/heartbeat-runs/run")
      return { id: "run", companyId: "company", status: "cancelled" };
    return undefined;
  });
  await item.service.configure("https://example.com");
  await item.service.selectIssue("issue");
  await item.service.command({ kind: "cancel", issueId: "issue", runId: "run" });
  assert.equal(item.writes.length, 1);
  assert.equal(Object.values(item.service.getSnapshot().receipts)[0]?.state, "confirmed");
});
