// @vitest-environment jsdom
// 修复原因：团队套餐业务错误（如"仅企业主账号可查询企业汇总数据"、
// "您当前暂无有效的团队套餐授权记录，无法创建API Key"）原先被 generic 文案
// 掩盖，且后者含"授权"会被误判为 credential 错误走翻译文案。本文件锁定
// 报错条参考 Plan Card teamUnavailable 样式原文展示业务错误的行为。

import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { UsageStatsErrorNotice } from "../src/settings/usage-stats/UsageStatsErrorNotice.js";

vi.mock("../src/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "en-US",
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("../src/lib/settingsNavigation.js", () => ({
  setPendingSettingsSection: vi.fn(),
}));

afterEach(() => {
  cleanup();
});

function renderNotice(error: string): string {
  return renderToStaticMarkup(
    createElement(UsageStatsErrorNotice, {
      error,
    } satisfies ComponentProps<typeof UsageStatsErrorNotice>),
  );
}

describe("UsageStatsErrorNotice", () => {
  // [leo] Leo 没有官方团队套餐，团队套餐业务错误原文展示分支已随 official-plan 残留一起删除，对应用例已移除。
  it("凭据错误保持翻译文案与检查 API Key 入口", () => {
    const html = renderNotice("token expired");

    expect(html).toContain("usage.error.stats.credential");
    expect(html).toContain("settings.usage.checkApiKey");
    expect(html).not.toContain("token expired");
  });

  it("其他错误保持 generic 文案", () => {
    const html = renderNotice("Request timed out after 15000ms");

    expect(html).toContain("usage.error.stats.generic");
    expect(html).not.toContain("Request timed out after 15000ms");
  });
});
