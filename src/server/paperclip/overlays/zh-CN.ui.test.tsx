import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BudgetPolicyCard } from "../components/BudgetPolicyCard";
import { BudgetIncidentCard } from "../components/BudgetIncidentCard";
import { BootstrapPendingPage } from "../components/BootstrapPendingPage";
import { AgentStatusBadge, IssueStatusBadge, StatusBadge } from "../components/StatusBadge";
import { ChineseError } from "../components/ChineseError";
vi.mock("@/lib/router", () => ({ Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a> }));

describe("Chinese operator UI rendering", () => {
  it("renders Chinese states without mutating raw protocol strings", () => {
    expect(renderToStaticMarkup(<IssueStatusBadge status="in_progress" />)).toContain("进行中");
    expect(renderToStaticMarkup(<AgentStatusBadge status="paused" />)).toContain("已暂停");
    expect(renderToStaticMarkup(<StatusBadge status="revision_requested" />)).toContain("要求修改");
  });
  it("renders first-admin public-mode instructions without inventing a browser claim", () => {
    const html = renderToStaticMarkup(<BootstrapPendingPage claimAvailable={false} session={null} claimState="idle" onClaim={() => {}} />);
    expect(html).toContain("首次管理员"); expect(html).toContain("公开模式");
    expect(html).toContain("bootstrap-ceo"); expect(html).not.toContain(">认领此实例<");
  });
  it("renders private-mode first-admin action in Chinese", () => {
    const html = renderToStaticMarkup(<BootstrapPendingPage claimAvailable session={{ user: { id: "test", name: "English User Name", email: "fixture@example.invalid" }, session: { id: "session", userId: "test" } } as never} claimState="idle" onClaim={() => {}} />);
    expect(html).toContain("认领此实例"); expect(html).toContain("fixture@example.invalid");
  });
  it("renders budget controls in USD with user names and amount cents unchanged", () => {
    const summary = { scopeType: "project", scopeName: "English Project 原名", windowKind: "lifetime", status: "hard_stop", amount: 10000, observedAmount: 11000, utilizationPercent: 110, remainingAmount: 0, warnPercent: 80, paused: true };
    const html = renderToStaticMarkup(<BudgetPolicyCard summary={summary as never} onSave={() => {}} />);
    expect(html).toContain("English Project 原名"); expect(html).toContain("累计预算");
    expect(html).toContain("预算（美元）"); expect(html).toContain("$100.00"); expect(html).toContain("已暂停");
    expect(summary.amount).toBe(10000); expect(summary.status).toBe("hard_stop");
  });
  it("renders the hard-stop resolution controls in Chinese", () => {
    const incident = { status: "open", approvalStatus: "pending", scopeType: "project", scopeName: "User Title Unchanged", amountObserved: 12500, amountLimit: 10000 };
    const html = renderToStaticMarkup(<BudgetIncidentCard incident={incident as never} onRaiseAndResume={() => {}} onKeepPaused={() => {}} />);
    expect(html).toContain("提高预算并恢复"); expect(html).toContain("保持暂停");
    expect(html).toContain("User Title Unchanged"); expect(html).toContain("$125.00");
  });
  it("keeps diagnostic data hidden until explicitly expanded", () => {
    const error = Object.assign(new Error("raw diagnostic intact"), { status: 403 });
    const html = renderToStaticMarkup(<ChineseError error={error} />);
    expect(html).toContain("没有执行此操作的权限"); expect(html).toContain("查看原始诊断");
    expect(html).not.toContain("raw diagnostic intact"); expect(error.message).toBe("raw diagnostic intact");
  });
});

import { describeCron } from "../lib/cron-readable";
import { formatMonitorAbsolute, formatMonitorEta, formatMonitorEtaLabel, deriveMonitorState } from "../lib/issue-monitor";
import { formatDate } from "../lib/utils";
import { timeAgo } from "../lib/timeAgo";

describe("Chinese dates, relative time and calendar wording", () => {
  it("renders common cron descriptions in Chinese without changing the expression", () => {
    expect(describeCron("*/15 * * * *")).toBe("每 15 分钟");
    expect(describeCron("0 9 * * 1-5")).toBe("每个工作日 09:00");
    expect(describeCron("30 8 * * 1")).toBe("每星期一 08:30");
    expect(describeCron("0 12 1 * *")).toBe("每月 1 日 12:00");
    expect(describeCron("not a cron expression")).toBeNull();
  });
  it("keeps timezone-aware today boundaries while displaying Chinese dates", () => {
    const reference = new Date("2026-10-04T00:00:00Z");
    expect(formatMonitorAbsolute("2026-10-04T12:00:00Z", { timeZone: "UTC" }, reference)).toContain("今天");
    const tomorrowInShanghai = formatMonitorAbsolute("2026-10-04T17:00:00Z", { timeZone: "Asia/Shanghai" }, reference);
    expect(tomorrowInShanghai).not.toContain("今天");
    expect(tomorrowInShanghai).toContain("10月5日");
    expect(tomorrowInShanghai).not.toMatch(/October|Monday|Sunday|AM|PM/);
    expect(formatDate("2026-10-04T12:00:00Z")).toContain("2026年10月4日");
  });
  it("renders relative times and overdue states in Chinese", () => {
    const now = new Date("2026-10-04T12:00:00Z");
    expect(formatMonitorEta("2026-10-04T12:05:00Z", now)).toBe("in 5m");
    expect(formatMonitorEtaLabel("2026-10-04T12:05:00Z", now)).toBe("5 分钟后");
    expect(formatMonitorEta("2026-10-04T11:59:30Z", now)).toBe("due now");
    expect(formatMonitorEtaLabel("2026-10-04T11:59:30Z", now)).toBe("现在到期");
    expect(formatMonitorEta("2026-10-04T09:00:00Z", now)).toBe("overdue by 3h");
    expect(formatMonitorEtaLabel("2026-10-04T09:00:00Z", now)).toBe("已逾期 3 小时");
    expect(deriveMonitorState({ status: "in_progress", monitorNextCheckAt: "2026-10-04T09:00:00Z" }, now).state).toBe("overdue");
    vi.useFakeTimers();
    try {
      vi.setSystemTime(now);
      expect(timeAgo("2026-10-04T11:55:00Z")).toBe("5分钟前");
    } finally { vi.useRealTimers(); }
  });
});

import type { DashboardSummary, ResourceMemberships, BudgetOverview } from "@paperclipai/shared";
import boardFixture from "./smoke-board-fixture.json";
import { computeInboxBadgeData } from "../lib/inbox";
it("the browser fixture satisfies shell dashboard/membership/budget contracts", () => {
  const dashboard: DashboardSummary = boardFixture.dashboard;
  const memberships: ResourceMemberships = boardFixture.memberships;
  const budgets: BudgetOverview = boardFixture.budgets;
  expect(memberships.starredAgentIds).toEqual([]);
  expect(budgets.activeIncidents).toEqual([]);
  expect(() => computeInboxBadgeData({ dashboard, approvals: [], joinRequests: [], heartbeatRuns: [], mineIssues: [], dismissedAlerts: new Set(), dismissedAtByKey: new Map() })).not.toThrow();
});
