import assert from "node:assert/strict";
import test from "node:test";
import { clearConfirmedPaperclipDraft } from "../src/paperclip/replyDraftConfirmation.js";
const binding = { serverUrl: "https://server.example", companyId: "company-1", userId: "user-1" };
const pending = { receiptId: "receipt-1", binding, body: "原回复", draft: "  原回复  " };
const confirmed = { receiptId: "receipt-1", binding, issueId: "issue-1", body: "原回复" };
test("精确回执确认清空仍未修改的原始草稿（包括提交时裁剪的空格）", () => {
  assert.equal(clearConfirmedPaperclipDraft("  原回复  ", pending, confirmed, "issue-1"), "");
});
test("同回执确认不清除用户已经修改的新草稿", () => {
  assert.equal(
    clearConfirmedPaperclipDraft("用户修改的新要求", pending, confirmed, "issue-1"),
    "用户修改的新要求",
  );
});
test("没有当前提交或没有服务器确认（包括普通同正文评论/手动解除）不能清草稿", () => {
  assert.equal(
    clearConfirmedPaperclipDraft(pending.draft, null, confirmed, "issue-1"),
    pending.draft,
  );
  assert.equal(
    clearConfirmedPaperclipDraft(pending.draft, pending, null, "issue-1"),
    pending.draft,
  );
});
test("其他回执、任务、正文不能确认当前草稿", () => {
  for (const changed of [
    { ...confirmed, receiptId: "receipt-other" },
    { ...confirmed, issueId: "issue-other" },
    { ...confirmed, body: "不同正文" },
  ]) {
    assert.equal(
      clearConfirmedPaperclipDraft(pending.draft, pending, changed, "issue-1"),
      pending.draft,
    );
  }
});
test("不同服务器、组织、账号的回执不能跨绑定清除草稿", () => {
  for (const changed of [
    { ...binding, serverUrl: "https://other.example" },
    { ...binding, companyId: "company-other" },
    { ...binding, userId: "user-other" },
  ]) {
    assert.equal(
      clearConfirmedPaperclipDraft(
        pending.draft,
        pending,
        { ...confirmed, binding: changed },
        "issue-1",
      ),
      pending.draft,
    );
  }
});
