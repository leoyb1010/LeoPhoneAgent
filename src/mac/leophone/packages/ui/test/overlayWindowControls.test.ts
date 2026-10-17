import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";

// [leo] Leo 删除了 EmbeddedWebsiteHeader、奖励中心（rewards/RewardsWebview）和 Coding Plan 内嵌升级网页，
// 对应的用例已移除；只保留仍存在的登录页覆盖层窗控断言。
it("登录页接入覆盖层窗控", async () => {
  const source = await readFile(resolve(__dirname, "../src/WelcomeScreen.tsx"), "utf8");
  expect(source).toContain("<DesktopOverlayWindowControls />");
});

it("登录页原生拖拽层避开窗控，并先于 no-drag 按钮声明", async () => {
  const source = await readFile(resolve(__dirname, "../src/WelcomeScreen.tsx"), "utf8");
  const drag = source.indexOf("[app-region:drag]");
  expect(drag).toBeGreaterThan(-1);
  expect(drag).toBeLessThan(source.indexOf("<DesktopOverlayWindowControls />"));
  expect(source).toContain("platform-windows-desktop:right-[134px]");
  expect(source).toContain("platform-linux-desktop:right-[134px]");
});
