import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RootStartupLoading } from "@/root/RootStartupLoading.js";

describe("RootStartupLoading", () => {
  // [leo] Leo shows the static LeoBot logo image (same as the HTML boot shell, no breathing
  // animation) instead of the animated ZCode SVG; the logo badge is no longer exported for onboarding.
  it("启动阻塞态使用静态 LeoBot 标志而不是可见 loading 文案", () => {
    const html = renderToStaticMarkup(createElement(RootStartupLoading, { label: "加载中..." }));

    expect(html).toContain('data-testid="root-startup-loading"');
    expect(html).toContain('aria-label="加载中..."');
    expect(html).toContain("<img");
    expect(html).toContain("LeoBot");
    expect(html).not.toContain("<animate");
    expect(html).toContain("bg-background");
    expect(html).not.toContain(">加载中...<");
  });
});
