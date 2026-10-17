import { describe, expect, it } from "vitest";
// [leo] Leo 精简了引导流程（去掉 welcome/wizard 视图切换），判定函数移到 useOnboardingMigration 且不再接收 view。
import { shouldAutoScanOnboardingSessions } from "@/onboarding/useOnboardingMigration.js";

describe("shouldAutoScanOnboardingSessions", () => {
  it("首次进入 session 步骤且尚未扫描时会自动触发", () => {
    expect(
      shouldAutoScanOnboardingSessions({
        wizardStep: "session",
        supported: true,
        isScanning: false,
        candidateCount: 0,
        scanError: null,
        hasAutoScannedInCurrentEntry: false,
      }),
    ).toBe(true);
  });

  it("空结果场景在当前步骤内只会自动扫描一次，避免重扫死循环", () => {
    expect(
      shouldAutoScanOnboardingSessions({
        wizardStep: "session",
        supported: true,
        isScanning: false,
        candidateCount: 0,
        scanError: null,
        hasAutoScannedInCurrentEntry: true,
      }),
    ).toBe(false);
  });

  it("已有结果时不会再次自动扫描", () => {
    expect(
      shouldAutoScanOnboardingSessions({
        wizardStep: "session",
        supported: true,
        isScanning: false,
        candidateCount: 3,
        scanError: null,
        hasAutoScannedInCurrentEntry: false,
      }),
    ).toBe(false);
  });
});
