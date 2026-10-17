import {
  Monitor,
  Moon,
  Settings,
  Settings2,
  Package,
  Bot,
  Palette,
  Sun,
  BarChart3,
  Terminal,
  AlarmClock,
  Anchor,
  Brain,
  Blocks,
  Globe2,
  Cable,
  WandSparkles,
  Keyboard,
  FileSearch,
  Smartphone,
} from "lucide-react";
import { isSettingsSectionEnabled, type SettingsSectionId } from "@/lib/settingsNavigation.js";
import type { Theme } from "@/useTheme.js";

export const THEME_MODES: Array<{
  mode: Theme;
  icon: typeof Sun;
}> = [
  { mode: "system", icon: Monitor },
  { mode: "zai-dark", icon: Moon },
  { mode: "zai-light", icon: Sun },
];

// [leo] 与 iOS 设置页对齐的四组信息架构，见 docs/specs/leo-settings-ia.md。
export type SettingsSectionGroupId = "providers" | "agent" | "devices" | "general";

interface SettingsSectionDefinition {
  id: SettingsSectionId;
  icon: typeof Settings;
  titleId: string;
  contentTitleId?: string;
  titleBadgeId?: string;
  /** 内容区标题下的一句话说明；导航搜索也会匹配它。 */
  hintId?: string;
  /** 搜索关键词（中英混排，不展示）。 */
  keywords?: string;
  groupId: SettingsSectionGroupId;
  /** 设为 "extensions" 的分区不单独出现在导航里，而是作为「扩展」页的一个 tab。 */
  navParentId?: "extensions";
}

const BASE_SETTINGS_SECTION_GROUPS: Array<{
  id: SettingsSectionGroupId;
  titleId: string;
}> = [
  { id: "providers", titleId: "settings.sidebar.group.providers" },
  { id: "agent", titleId: "settings.sidebar.group.agent" },
  { id: "devices", titleId: "settings.sidebar.group.devices" },
  { id: "general", titleId: "settings.sidebar.group.general" },
];

/** 「扩展」导航入口本身；页面内容由当前 tab（plugin/mcp/skill/commands/hooks）决定。 */
const EXTENSIONS_NAV_ENTRY: SettingsSectionDefinition = {
  id: "extensions",
  icon: Blocks,
  titleId: "settings.extensions.title",
  hintId: "settings.extensions.hint",
  keywords:
    "extensions 扩展 plugin 插件 mcp server 工具 tools skill 技能 command 命令 slash hooks 钩子 marketplace 市场",
  groupId: "agent",
};

const BASE_SETTINGS_SECTIONS: SettingsSectionDefinition[] = [
  {
    id: "modelProvider",
    icon: Package,
    titleId: "settings.modelProviderTitle",
    hintId: "settings.modelProvider.hint",
    keywords:
      "provider providers api key 密钥 模型 model models llm openai anthropic claude gemini 供应商 服务商 base url oauth 订阅",
    groupId: "providers",
  },
  {
    id: "memory",
    icon: Brain,
    titleId: "settings.memory",
    hintId: "settings.memory.hint",
    keywords: "memory 记忆 长期记忆 偏好 agents.md",
    groupId: "agent",
  },
  {
    id: "subagents",
    icon: Bot,
    titleId: "settings.subagents.title",
    hintId: "settings.subagents.hint",
    keywords: "subagent subagents sub agent 子代理 子智能体 委派 并行 角色",
    groupId: "agent",
  },
  {
    id: "plugin",
    icon: Blocks,
    titleId: "settings.plugins.title",
    keywords: "plugin plugins 插件 marketplace 市场 安装",
    groupId: "agent",
    navParentId: "extensions",
  },
  {
    id: "mcp",
    icon: Cable,
    titleId: "settings.mcpTitle",
    keywords: "mcp server servers 工具 tools 集成 integration",
    groupId: "agent",
    navParentId: "extensions",
  },
  {
    id: "skill",
    icon: WandSparkles,
    titleId: "settings.skills.title",
    keywords: "skill skills 技能 技能包",
    groupId: "agent",
    navParentId: "extensions",
  },
  {
    id: "commands",
    icon: Terminal,
    titleId: "settings.commands.title",
    keywords: "command commands slash 斜杠 命令 指令",
    groupId: "agent",
    navParentId: "extensions",
  },
  {
    id: "hooks",
    icon: Anchor,
    titleId: "settings.hooks.title",
    keywords: "hook hooks 钩子 事件 脚本 event",
    groupId: "agent",
    navParentId: "extensions",
  },
  {
    id: "automations",
    icon: AlarmClock,
    titleId: "settings.automations.title",
    titleBadgeId: "settings.automations.betaBadge",
    groupId: "agent",
  },
  // [leo] 连接手机：Leo Link 中继配对、Tailscale 直连与同步副本，只在桌面端（有 Leo Link 桥接）出现。
  {
    id: "phone",
    icon: Smartphone,
    titleId: "settings.phone.title",
    hintId: "settings.phone.hint",
    keywords:
      "phone 手机 iphone ios 配对 pair pairing 二维码 qr leo link relay 中继 tailscale 直连 同步 sync 远控 remote",
    groupId: "devices",
  },
  {
    id: "browser",
    icon: Globe2,
    titleId: "settings.browser.title",
    hintId: "settings.browser.hint",
    keywords: "browser 浏览器 chrome 网页 控制 证书 certificate cookie 导入 import",
    groupId: "devices",
  },
  // 电脑控制与浏览器同属本机操控入口（当前隐藏，保留 id 供旧入口路由）。
  {
    id: "computerUse",
    icon: Monitor,
    titleId: "settings.computerUse.title",
    keywords: "computer use 电脑控制 屏幕 screen",
    groupId: "devices",
  },
  {
    id: "general",
    icon: Settings2,
    titleId: "settings.systemTitle",
    hintId: "settings.general.hint",
    keywords:
      "general 常规 语言 language 通知 notification 代理 proxy 终端 terminal 更新 update 数据 data",
    groupId: "general",
  },
  {
    id: "appearance",
    icon: Palette,
    titleId: "settings.appearanceTitle",
    hintId: "settings.appearance.hint",
    keywords: "appearance 外观 主题 theme dark light 深色 浅色 字体 font 字号 代码 code 预览 行号",
    groupId: "general",
  },
  {
    id: "shortcuts",
    icon: Keyboard,
    titleId: "settings.shortcuts.title",
    hintId: "settings.shortcuts.hint",
    keywords: "shortcut shortcuts keyboard 快捷键 键盘 按键 keybinding hotkey",
    groupId: "general",
  },
  // 工作区搜索范围（.zcodeignore）：当前隐藏，保留 id。
  {
    id: "workspaceFileSearch",
    icon: FileSearch,
    titleId: "settings.workspaceFileSearch.title",
    groupId: "general",
  },
  {
    id: "usage",
    icon: BarChart3,
    titleId: "settings.usageTitle",
    hintId: "settings.usage.hint",
    keywords: "usage 使用统计 用量 token tokens 统计 stats 费用 cost",
    groupId: "general",
  },
];

/** 「扩展」页的 tab 顺序即定义顺序。 */
export const EXTENSION_SETTINGS_SECTION_IDS: readonly SettingsSectionId[] =
  BASE_SETTINGS_SECTIONS.filter((section) => section.navParentId === "extensions").map(
    (section) => section.id,
  );

/** 当前分区在导航上对应的入口 id：扩展的 tab 都高亮「扩展」。 */
export function resolveSettingsNavEntryId(section: SettingsSectionId): SettingsSectionId {
  return EXTENSION_SETTINGS_SECTION_IDS.includes(section) ? "extensions" : section;
}

// 兼容既有只读消费者：默认配置代表不带桌面平台能力的 Web 视图；
// macOS/Windows/Linux 必须继续通过 createSettingsPageConfig 动态加入 Computer Use。
export const SETTINGS_SECTIONS = BASE_SETTINGS_SECTIONS.filter(
  (section) =>
    section.id !== "computerUse" && section.id !== "phone" && isSettingsSectionEnabled(section.id),
);

export interface SettingsPageConfigOptions {
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
}

export function createSettingsPageConfig({
  isDesktop = false,
  isMacDesktop = false,
  isWindowsDesktop = false,
}: SettingsPageConfigOptions = {}) {
  const hasDesktopPlatform = isDesktop || isMacDesktop || isWindowsDesktop;
  // settingsSections：所有可路由分区（含扩展的各 tab）；导航只展示 settingsSectionGroups。
  const settingsSections = BASE_SETTINGS_SECTIONS.filter((section) => {
    if ((section.id === "computerUse" || section.id === "phone") && !hasDesktopPlatform) {
      return false;
    }
    return isSettingsSectionEnabled(section.id);
  });
  const extensionSections = settingsSections.filter(
    (section) => section.navParentId === "extensions",
  );
  const navEntries = settingsSections.flatMap((section) => {
    if (section.navParentId !== "extensions") return [section];
    // 「扩展」入口放在第一个扩展 tab 原来的位置。
    return section.id === extensionSections[0]?.id ? [EXTENSIONS_NAV_ENTRY] : [];
  });
  const settingsSectionGroups = BASE_SETTINGS_SECTION_GROUPS.map((group) => ({
    ...group,
    sections: navEntries.filter((section) => section.groupId === group.id),
  })).filter((group) => group.sections.length > 0);

  return {
    settingsSectionGroups,
    settingsSections,
    extensionSections,
    extensionsNavEntry: extensionSections.length > 0 ? EXTENSIONS_NAV_ENTRY : null,
  };
}

interface GeneralSettingsSearchRow {
  /** 与 GeneralSectionContent 中 SettingsRow 的 rowId 一致。 */
  rowId: string;
  labelId: string;
  keywords: string;
  requires?: "desktop" | "windowsDesktop" | "windowsHost";
}

/** 「常规」页可被导航搜索直接命中的设置行（顺序即页面顺序）。 */
export const GENERAL_SETTINGS_SEARCH_ROWS: readonly GeneralSettingsSearchRow[] = [
  {
    rowId: "locale",
    labelId: "settings.locale",
    keywords: "language 语言 中文 english locale",
  },
  {
    rowId: "notification",
    labelId: "settings.notification",
    keywords: "notification 通知 提醒",
  },
  {
    rowId: "notificationSound",
    labelId: "settings.notificationSound",
    keywords: "sound 提示音 声音 notification",
  },
  {
    rowId: "keepAwake",
    labelId: "settings.keepAwakeWhileRunning",
    keywords: "keep awake 防休眠 休眠 sleep caffeinate",
    requires: "desktop",
  },
  {
    rowId: "closeToTray",
    labelId: "settings.closeToTrayOnWindows",
    keywords: "tray 托盘 关闭 close",
    requires: "windowsDesktop",
  },
  {
    rowId: "autoUpdate",
    labelId: "settings.autoDownloadAndInstallUpdates",
    keywords: "update updates 更新 自动更新 upgrade 升级",
    requires: "desktop",
  },
  {
    rowId: "interactionBehavior",
    labelId: "settings.zcodeInteractionBehavior",
    keywords: "queue guide 排队 引导 发送 interaction",
  },
  {
    rowId: "askUserQuestionAutoResolution",
    labelId: "settings.askUserQuestionAutoResolution",
    keywords: "question 提问 自动 auto",
  },
  {
    rowId: "messageStreamShowReasoning",
    labelId: "settings.messageStreamShowReasoning",
    keywords: "reasoning thinking 思考 推理",
  },
  {
    rowId: "messageStreamShowTodos",
    labelId: "settings.messageStreamShowTodos",
    keywords: "todo todos 待办",
  },
  {
    rowId: "toolGroupingExplore",
    labelId: "settings.toolGroupingExplore",
    keywords: "tool 工具 分组 group explore",
  },
  {
    rowId: "toolGroupingTerminal",
    labelId: "settings.toolGroupingTerminal",
    keywords: "tool 工具 分组 group terminal 终端",
  },
  {
    rowId: "toolGroupingChanges",
    labelId: "settings.toolGroupingChanges",
    keywords: "tool 工具 分组 group changes 变更",
  },
  {
    rowId: "modelIoFullRetention",
    labelId: "settings.modelIoFullRetention",
    keywords: "log logs 日志 保留 retention debug",
  },
  {
    rowId: "dataBaseDir",
    labelId: "settings.dataBaseDir",
    keywords: "data 数据 目录 路径 storage path 存储 home",
  },
  {
    rowId: "taskAutoArchive",
    labelId: "settings.taskAutoArchive",
    keywords: "archive 归档 自动归档",
  },
  {
    rowId: "taskAutoArchiveDays",
    labelId: "settings.taskAutoArchiveDays",
    keywords: "archive 归档 天数 days",
  },
  {
    rowId: "terminalProfile",
    labelId: "settings.terminalProfile",
    keywords: "terminal 终端 profile shell zsh bash",
  },
  {
    rowId: "terminalFontFamily",
    labelId: "settings.terminalFontFamily",
    keywords: "terminal 终端 font 字体",
  },
  {
    rowId: "integratedTerminalShell",
    labelId: "settings.integratedTerminalShell",
    keywords: "terminal 终端 shell powershell",
    requires: "windowsHost",
  },
  {
    rowId: "nativeSearchEnhancements",
    labelId: "settings.nativeSearchEnhancements",
    keywords: "search 搜索 ripgrep",
  },
  {
    rowId: "httpProxy",
    labelId: "settings.httpProxy",
    keywords: "proxy 代理 http https network 网络",
  },
  {
    rowId: "httpProxyNoProxy",
    labelId: "settings.httpProxyNoProxy",
    keywords: "no_proxy no proxy 绕过 代理 bypass",
  },
  {
    rowId: "httpProxyCaCertPath",
    labelId: "settings.httpProxyCaCertPath",
    keywords: "ca cert certificate 证书 代理 tls ssl",
  },
  {
    rowId: "hardwareAcceleration",
    labelId: "settings.desktopChromiumHardwareAcceleration",
    keywords: "gpu hardware acceleration 硬件加速 渲染",
    requires: "desktop",
  },
  {
    rowId: "onboarding",
    labelId: "settings.onboarding",
    keywords: "migration 迁移 向导 wizard claude code 导入 import",
  },
];

export function resolveSettingsSectionForPlatform(
  section: SettingsSectionId,
  visibleSections: ReadonlyArray<Pick<SettingsSectionDefinition, "id">>,
  fallbackSection: SettingsSectionId = "modelProvider",
): SettingsSectionId {
  if (visibleSections.some((candidate) => candidate.id === section)) return section;
  if (visibleSections.some((candidate) => candidate.id === fallbackSection)) {
    return fallbackSection;
  }
  return visibleSections[0]?.id ?? "modelProvider";
}

export type { SettingsSectionId };
