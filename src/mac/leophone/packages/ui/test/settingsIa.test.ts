import assert from "node:assert/strict";
import test from "node:test";

import { resolveSettingsSection } from "../src/lib/settingsNavigation.js";
import {
  createSettingsPageConfig,
  EXTENSION_SETTINGS_SECTION_IDS,
  resolveSettingsNavEntryId,
  resolveSettingsSectionForPlatform,
} from "../src/settings/settingsPageConfig.js";
import {
  buildSettingsSearchCandidates,
  filterSettingsSearchCandidates,
} from "../src/settings/settingsSearch.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

// 设置页信息架构（docs/specs/leo-settings-ia.md）：四组、扩展合并、搜索命中。
function navIds(config: ReturnType<typeof createSettingsPageConfig>) {
  return config.settingsSectionGroups.map((group) => [
    group.id,
    group.sections.map((section) => section.id),
  ]);
}

test("desktop settings nav has four groups in iOS order", () => {
  const config = createSettingsPageConfig({ isDesktop: true, isMacDesktop: true });
  assert.deepEqual(navIds(config), [
    ["providers", ["modelProvider"]],
    ["agent", ["memory", "subagents", "extensions"]],
    ["devices", ["phone", "browser", "computerUse"]],
    ["general", ["general", "appearance", "shortcuts", "usage"]],
  ]);
});

test("电脑操作 (Peekaboo) only shows on macOS desktop", () => {
  const windows = createSettingsPageConfig({ isDesktop: true, isWindowsDesktop: true });
  const devices = windows.settingsSectionGroups.find((group) => group.id === "devices");
  assert.deepEqual(
    devices?.sections.map((section) => section.id),
    ["phone", "browser"],
  );
});

test("web settings hide the desktop-only phone page", () => {
  const config = createSettingsPageConfig();
  const devices = config.settingsSectionGroups.find((group) => group.id === "devices");
  assert.deepEqual(
    devices?.sections.map((section) => section.id),
    ["browser"],
  );
  assert.equal(
    resolveSettingsSectionForPlatform("phone", config.settingsSections),
    "modelProvider",
  );
});

test("old extension section ids stay routable and highlight 扩展", () => {
  const config = createSettingsPageConfig({ isDesktop: true });
  assert.deepEqual(EXTENSION_SETTINGS_SECTION_IDS, ["plugin", "mcp", "skill", "commands", "hooks"]);
  for (const id of EXTENSION_SETTINGS_SECTION_IDS) {
    assert.equal(resolveSettingsSectionForPlatform(id, config.settingsSections), id);
    assert.equal(resolveSettingsNavEntryId(id), "extensions");
  }
  assert.equal(resolveSettingsSection("extensions"), "plugin");
  assert.equal(resolveSettingsSection("plugins"), "plugin");
  assert.equal(resolveSettingsNavEntryId("general"), "general");
});

function candidates(locale: Record<string, string>, isDesktop = true) {
  return buildSettingsSearchCandidates({
    config: createSettingsPageConfig({ isDesktop }),
    formatMessage: (id) => locale[id] ?? id,
    isDesktop,
    isWindowsDesktop: false,
    isWindowsHost: false,
  });
}

function keys(query: string, locale: Record<string, string> = zhCN) {
  return filterSettingsSearchCandidates(query, candidates(locale)).map((item) => item.key);
}

test("search matches bilingual keywords at section and row level", () => {
  assert.ok(keys("MCP").includes("section:mcp"));
  assert.ok(keys("mcp").includes("section:extensions"));
  assert.ok(keys("密钥").includes("section:modelProvider"));
  assert.ok(keys("api key").includes("section:modelProvider"));
  assert.ok(keys("Tailscale").includes("section:phone"));
  assert.ok(keys("配对").includes("section:phone"));
  assert.ok(keys("theme").includes("section:appearance"));
  assert.ok(keys("主题").includes("section:appearance"));
  assert.ok(keys("快捷键").includes("section:shortcuts"));
  assert.ok(keys("代理").includes("row:httpProxy"));
  assert.ok(keys("proxy", enUS).includes("row:httpProxyNoProxy"));
  assert.deepEqual(keys("   "), []);
  assert.deepEqual(keys("zzzz-no-such-setting"), []);
});

test("label matches rank above keyword-only matches", () => {
  // 回车打开第一条：搜「代理」必须先给「HTTP 代理」，不能是关键词里带「子代理」的子智能体。
  const ranked = keys("代理");
  assert.equal(ranked[0], "row:httpProxy");
  assert.ok(ranked.indexOf("row:httpProxy") < ranked.indexOf("section:subagents"));
  assert.equal(keys("外观")[0], "section:appearance");
});

test("row results carry the general section and platform-gated rows are skipped", () => {
  const proxy = filterSettingsSearchCandidates("代理", candidates(zhCN)).find(
    (item) => item.key === "row:httpProxy",
  );
  assert.equal(proxy?.sectionId, "general");
  assert.equal(proxy?.rowId, "httpProxy");
  const webKeys = filterSettingsSearchCandidates("硬件加速", candidates(zhCN, false)).map(
    (item) => item.key,
  );
  assert.ok(!webKeys.includes("row:hardwareAcceleration"));
  assert.ok(!keys("Tailscale").includes("row:closeToTray"));
});

test("every nav entry has a zh and en hint", () => {
  const config = createSettingsPageConfig({ isDesktop: true });
  for (const group of config.settingsSectionGroups) {
    assert.ok(zhCN[group.titleId] && enUS[group.titleId], group.titleId);
    for (const entry of group.sections) {
      assert.ok(entry.hintId, `${entry.id} needs a hint`);
      assert.ok(zhCN[entry.hintId] && enUS[entry.hintId], entry.hintId);
    }
  }
});
