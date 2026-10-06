import assert from "node:assert/strict";
import { test } from "node:test";
import type { NativePaperclipPort, PaperclipPreferences } from "@zcode/shared";
import { createPaperclipWorkspace } from "./createWorkspace.js";
import { paperclipApprovalFingerprint } from "../domain/approval.js";

type Input = Parameters<NativePaperclipPort["request"]>[0];
const issue = {
  id: "issue",
  companyId: "company",
  title: "任务",
  status: "todo",
  priority: "medium",
};
function fixture(
  override: (input: Input) => Promise<{ status: number; data: unknown } | undefined>,
) {
  let preferences: PaperclipPreferences = { origin: "", companies: {} };
  const writes: Input[] = [];
  const port: NativePaperclipPort = {
    getPreferences: async () => preferences,
    setPreferences: async (value) => {
      preferences = structuredClone(value);
    },
    signIn: async () => ({ completed: true }),
    signOut: async () => {},
    download: async () => {},
    request: async (input) => {
      if (input.method !== "GET") writes.push(input);
      const custom = await override(input);
      if (custom) return custom;
      const path = input.path.split("?")[0];
      const data =
        path === "/api/health"
          ? { status: "ok", deploymentMode: "authenticated" }
          : path === "/api/auth/get-session"
            ? { user: { id: "human" } }
            : path === "/api/companies"
              ? [{ id: "company", name: "公司" }]
              : path === "/api/companies/company/issues"
                ? [issue]
                : path === "/api/issues/issue"
                  ? issue
                  : [];
      return { status: 200, data };
    },
  };
  return { port, writes, service: createPaperclipWorkspace(port) };
}
const create = {
  kind: "create" as const,
  requestId: "request",
  firstSubmittedAt: Date.now(),
  retry: false,
  title: "任务",
  description: "",
};
test("an unknown mutation survives reconstruction and manual archive never sends", async () => {
  const item = fixture(async (input) =>
    input.method === "POST" ? Promise.reject(new Error("lost")) : undefined,
  );
  await item.service.configure("https://example.com");
  await assert.rejects(item.service.command(create));
  const restored = createPaperclipWorkspace(item.port);
  await restored.initialize();
  assert.equal(restored.getSnapshot().receipts.request?.state, "unknown");
  await assert.rejects(restored.command({ ...create, requestId: "new" }));
  await restored.command({ kind: "archive", receiptId: "request" });
  assert.equal(restored.getSnapshot().receipts.request?.state, "archived");
  assert.equal(item.writes.length, 1);
  const reopened = createPaperclipWorkspace(item.port);
  await reopened.initialize();
  assert.equal(reopened.getSnapshot().receipts.request?.state, "archived");
});
test("approval payload or requester changes must be reviewed before sending", async () => {
  let changed = false;
  const approval = () => ({
    id: "approval",
    companyId: "company",
    type: "hire_agent",
    status: "pending",
    payload: { permissions: changed ? "admin" : "read" },
    requestedByUserId: changed ? "other" : "human",
  });
  const item = fixture(async (input) =>
    input.path.includes("/approvals")
      ? { status: 200, data: input.path === "/api/approvals/approval" ? approval() : [approval()] }
      : undefined,
  );
  await item.service.configure("https://example.com");
  await item.service.selectIssue("issue");
  const displayed = item.service.getSnapshot().detail!.approvals[0]!;
  changed = true;
  await assert.rejects(
    item.service.command({
      kind: "approval",
      issueId: "issue",
      approvalId: "approval",
      approve: true,
      note: "",
      expectedApproval: paperclipApprovalFingerprint(displayed),
    }),
  );
  assert.equal(item.writes.length, 0);
});
test("log continuation uses the returned offset without duplicating the first page", async () => {
  const offsets: string[] = [];
  const item = fixture(async (input) => {
    if (input.path.endsWith("/runs"))
      return { status: 200, data: [{ runId: "run", agentId: "agent", status: "running" }] };
    if (!input.path.includes("/log?")) return undefined;
    const offset = new URL(input.path, "https://example.com").searchParams.get("offset")!;
    offsets.push(offset);
    return {
      status: 200,
      data: {
        runId: "run",
        content: offset === "0" ? "first" : "second",
        nextOffset: offset === "0" ? 5 : 11,
      },
    };
  });
  await item.service.configure("https://example.com");
  await item.service.selectIssue("issue");
  await item.service.readLog("run");
  await item.service.readLog("run");
  assert.deepEqual(offsets, ["0", "5"]);
  assert.equal(item.service.getSnapshot().log?.content, "firstsecond");
});
test("missing or stalled log cursors are rejected without replacing a valid page", async () => {
  let nextOffset: number | undefined = 5;
  const item = fixture(async (input) => {
    if (input.path.endsWith("/runs"))
      return { status: 200, data: [{ runId: "run", agentId: "agent", status: "running" }] };
    if (input.path.includes("/log?"))
      return { status: 200, data: { runId: "run", content: "first", nextOffset } };
    return undefined;
  });
  await item.service.configure("https://example.com");
  await item.service.selectIssue("issue");
  await item.service.readLog("run");
  for (const cursor of [undefined, 4, 5]) {
    nextOffset = cursor;
    await assert.rejects(item.service.readLog("run"));
    assert.equal(item.service.getSnapshot().log?.content, "first");
  }
});
test("receipt storage failure prevents the remote write", async () => {
  const item = fixture(async () => undefined);
  await item.service.configure("https://example.com");
  item.port.setPreferences = async () => {
    throw new Error("disk full");
  };
  await assert.rejects(item.service.command(create));
  assert.equal(item.writes.length, 0);
});
test("switching task cannot bypass an unresolved write in the same identity", async () => {
  const item = fixture(async (input) =>
    input.method === "POST" ? Promise.reject(new Error("lost")) : undefined,
  );
  await item.service.configure("https://example.com");
  await assert.rejects(item.service.command(create));
  await item.service.selectIssue("issue");
  await assert.rejects(item.service.command({ ...create, requestId: "another" }));
  assert.equal(item.writes.length, 1);
});
test("approval fingerprint includes applicant but ignores JSON property ordering", () => {
  const approval = {
    id: "approval",
    companyId: "company",
    type: "hire_agent",
    status: "pending",
    payload: { role: "read", budget: 1 },
    requestedByUserId: "human",
  };
  const fingerprint = paperclipApprovalFingerprint(approval);
  assert.equal(
    fingerprint,
    paperclipApprovalFingerprint({ ...approval, payload: { budget: 1, role: "read" } }),
  );
  assert.notEqual(
    fingerprint,
    paperclipApprovalFingerprint({ ...approval, requestedByUserId: "another" }),
  );
});
test("two windows sharing one settings store keep each other's unknown receipts", async () => {
  const item = fixture(async (input) =>
    input.method === "POST" ? Promise.reject(new Error("lost")) : undefined,
  );
  await item.service.configure("https://example.com");
  // 第二个服务器窗口:在第一个窗口记下回执之前就已经读好了自己那份 preferences。
  const second = createPaperclipWorkspace(item.port);
  await second.initialize();
  await assert.rejects(item.service.command(create));
  await assert.rejects(second.command({ ...create, requestId: "other" }));
  const reopened = createPaperclipWorkspace(item.port);
  await reopened.initialize();
  const receipts = reopened.getSnapshot().receipts;
  // 以前第二个窗口整份写回,第一个窗口的「待核对」被抹掉,重复写入的阻挡也随之解除。
  assert.equal(receipts.request?.state, "unknown");
  assert.equal(receipts.other?.state, "unknown");
});
