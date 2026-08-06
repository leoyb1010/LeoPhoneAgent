/**
 * Shared Settings tab definitions — single source of truth for tab IDs and their i18n keys.
 *
 * Used by SettingsView (sidebar labels) and HelpThreadView ("Open X tab" button label).
 */

export type SettingsTab =
  | 'general'
  | 'billing'
  | 'personalization'
  | 'providers'
  | 'api-keys'
  | 'voice-input'
  | 'shortcuts'
  | 'agent-island'
  | 'import'
  | 'connections'
  | 'remote-control'
  | 'fleet'
  | 'tina'
  | 'builtin-tools'
  | 'computer-use'
  | 'im-bot'
  | 'help'
  | 'about';

/**
 * LeoAgent:侧栏分组(个人版信息架构)。13 个平铺 tab 按使用频率归入分组,
 * 常用在前、维护类折进"高级"。组标题渲染在侧栏,tab id 与深链完全不变。
 */
export const TAB_GROUPS: ReadonlyArray<{ label: string; tabs: ReadonlyArray<SettingsTab> }> = [
  { label: '常用', tabs: ['general', 'personalization', 'providers'] },
  { label: '我的设备', tabs: ['fleet', 'remote-control'] },
  { label: '输入', tabs: ['voice-input', 'shortcuts'] },
  { label: '高级', tabs: ['builtin-tools', 'computer-use', 'agent-island', 'import', 'im-bot', 'billing'] },
  { label: '帮助', tabs: ['help', 'about'] },
];

/**
 * 设置搜索索引:tab → 关键词(中文为主,含常见英文别名)。搜索框按它过滤。
 */
export const TAB_KEYWORDS: Record<SettingsTab, string> = {
  general: '通用 语言 通知 外观 显示 general language notification',
  billing: '用量 账单 billing usage',
  personalization: '个性化 主题 字体 字号 侧栏 卡片 theme font',
  providers: '模型 供应商 API key BYOK ChatGPT Claude Anthropic OpenAI grok xai model provider',
  'api-keys': '工具密钥 api keys',
  'voice-input': '语音 输入 听写 voice asr',
  shortcuts: '快捷键 键盘 shortcut keyboard',
  'agent-island': '灵动岛 island 吉祥物',
  import: '导入 会话 迁移 import session',
  connections: '第三方 connections',
  'remote-control': 'SSH 远程 主机 备用 remote host',
  fleet: '舰队 我的 Mac 中继 relay 设备 机器 fleet macbook cortex studio',
  tina: '机器人 tina',
  'builtin-tools': '工具 内置 浏览器 browser tools',
  'computer-use': '计算机使用 屏幕 computer use',
  'im-bot': '机器人 微信 飞书 钉钉 Telegram Discord bot im',
  help: '帮助 教程 help',
  about: '关于 版本 更新 日志 about version update log',
};

export const TAB_IDS: ReadonlyArray<SettingsTab> = [
  'general',
  'personalization',
  'providers',
  'billing',
  // 「工具密钥」(api-keys)已于 2026-07-13 下架:面板里最后一把 mivo key 随
  // XD Mivo 意识化改由意识设置页收单(官方别名映射同一存储键)。id 仍留在
  // SettingsTab 类型与 TAB_LABEL_KEY 保留,供旧深链重定向到插件页。
  'voice-input',
  // IM 机器人紧随语音输入(Lizi 2026-07-15 拍板)。
  'im-bot',
  'shortcuts',
  'agent-island',
  'import',
  // 「第三方平台」(connections)已于 2026-07-15 下架:Slack 官方 MCP 随 cindy-slack
  // 意识化收尾(Google/Jira/GitHub/GitLab 此前已迁意识)。id 仍留在 SettingsTab
  // 类型与 TAB_LABEL_KEY 保留,供旧深链重定向到插件页。
  'fleet',
  'remote-control',
  'builtin-tools',
  'computer-use',
  'help',
  'about',
];

export const TAB_LABEL_KEY: Record<SettingsTab, string> = {
  general: 'settings.tabs.general',
  billing: 'settings.tabs.billing',
  personalization: 'settings.tabs.personalization',
  'api-keys': 'settings.tabs.apiKeys',
  'voice-input': 'settings.tabs.voiceInput',
  shortcuts: 'settings.tabs.shortcuts',
  'agent-island': 'settings.tabs.agentIsland',
  import: 'settings.tabs.import',
  connections: 'settings.tabs.connections',
  providers: 'settings.tabs.providers',
  'remote-control': 'settings.tabs.remoteControl',
  fleet: 'settings.tabs.fleet',
  tina: 'settings.tabs.tina',
  'builtin-tools': 'settings.tabs.builtinTools',
  'computer-use': 'settings.tabs.computerUse',
  'im-bot': 'settings.tabs.imBot',
  help: 'settings.tabs.help',
  about: 'settings.tabs.about',
};

// 只校验当前「可见/可路由」的 tab(即 TAB_IDS 里的项)。注意 `tina` 仍保留在
// SettingsTab 类型与 TAB_LABEL_KEY 中(供 SettingsView 的 `?tab=tina` → `im-bot`
// legacy 重定向复用),但已从 TAB_IDS 移除,因此 isSettingsTab('tina') 返回 false
// 是有意为之——tina 不再是独立可停靠的 tab,重定向在调用本守卫之前就已处理。
export function isSettingsTab(value: string | null): value is SettingsTab {
  return value !== null && (TAB_IDS as ReadonlyArray<string>).includes(value);
}
