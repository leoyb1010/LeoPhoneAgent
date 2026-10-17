import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Settings usage provider tabs", () => {
  // [leo] Coding Plan usage sources were removed (no official accounts); the usage page only
  // shows the local app-usage tab, still rendered with the plugin store SegmentPill style.
  it("reuses the plugin store Public and Personal segment pill style", async () => {
    const settingsPageSource = await readFile("packages/ui/src/SettingsPage.tsx", "utf8");
    const pluginStoreSource = await readFile(
      "packages/ui/src/settings/PluginStoreListView.tsx",
      "utf8",
    );
    const start = settingsPageSource.indexOf("function SettingsUsageProviderTabs");
    const end = settingsPageSource.indexOf("function SettingsSidebarButton", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const usageTabsSource = settingsPageSource.slice(start, end);

    expect(pluginStoreSource).toContain("export function SegmentPill");
    expect(usageTabsSource).toContain("<SegmentPill");
    expect(usageTabsSource).toContain('id: "settings.usage.tab.appUsage"');
    expect(usageTabsSource).toContain('className="flex items-center gap-1.5"');
    expect(usageTabsSource).not.toContain("TabsList");
    expect(usageTabsSource).not.toContain("TabsTrigger");
    expect(settingsPageSource).not.toContain("function hasActiveCodingPlanSnapshot");
  });
});
