import type { SettingsSectionId } from "@/lib/settingsNavigation.js";

/**
 * [leo] 非「常规」分区里的具体设置项也要能搜到（以前只索引分区标题：搜「藏宝阁」得到「没有匹配」，
 * 而开关其实在「记忆」和「连接手机」里）。命中后跳到对应分区；带 rowId 的再滚到那一行。
 */
export interface SectionSettingsSearchRow {
  sectionId: SettingsSectionId;
  label: string;
  keywords: string;
  rowId?: string;
}

export const SECTION_SETTINGS_SEARCH_ROWS: readonly SectionSettingsSearchRow[] = [
  { sectionId: "memory", label: "藏宝阁召回", keywords: "treasury 藏宝阁 收藏 资料库 知识库 召回 recall 第二大脑", rowId: "leo-memory-recall-treasury" },
  { sectionId: "memory", label: "项目记忆召回", keywords: "project memory 项目记忆 召回 recall agents.md" },
  { sectionId: "phone", label: "藏宝阁访问（手机）", keywords: "treasury 藏宝阁 手机 iphone 同步 访问", rowId: "phoneTreasury" },
  { sectionId: "phone", label: "同步副本", keywords: "sync replica 同步副本 同步 iphone 备份", rowId: "phoneSyncReplica" },
  { sectionId: "phone", label: "扫码连接手机", keywords: "qr 二维码 扫码 配对 pair iphone leo link 中继 relay" },
  { sectionId: "phone", label: "Tailscale 直连", keywords: "tailscale 直连 direct https 端口 授权 grant 已授权设备 加密" },
  { sectionId: "computerUse", label: "屏幕录制权限", keywords: "screen recording 屏幕录制 权限 截图 看屏" },
  { sectionId: "computerUse", label: "辅助功能权限", keywords: "accessibility 辅助功能 权限 点击 输入 操控" },
  { sectionId: "externalAgents", label: "Claude Code 登录", keywords: "claude code 登录 login 令牌 token oauth" },
  { sectionId: "externalAgents", label: "Codex / Gemini / opencode / Grok 登录", keywords: "codex gemini opencode grok 登录 login" },
  { sectionId: "externalAgents", label: "外部 agent 使用系统代理", keywords: "proxy 代理 系统代理 外部 agent clash" },
  { sectionId: "modelProvider", label: "订阅账号登录", keywords: "chatgpt copilot opencode go 订阅 subscription 登录 oauth" },
  { sectionId: "modelProvider", label: "从 iPhone 导入模型", keywords: "iphone 导入 import 模型 供应商" },
  { sectionId: "modelProvider", label: "添加供应商", keywords: "add provider 添加 供应商 api key base url" },
  { sectionId: "appearance", label: "代码主题", keywords: "code theme 代码主题 高亮 github" },
  { sectionId: "appearance", label: "界面字号", keywords: "font size 字号 字体 大小" },
  { sectionId: "shortcuts", label: "快速派发快捷键（⌥Space）", keywords: "quick entry 快速派发 浮窗 option space alt 菜单栏" },
];
