import type { ComponentType } from 'react';
import {
  Bell,
  Bot,
  Boxes,
  GitBranch,
  HardDrive,
  Info,
  KeyRound,
  ListChecks,
  Mic,
  MonitorPlay,
  Palette,
  Plug,
  Server,
  Sparkles,
} from 'lucide-react';

import type {
  CodeEditorSettingsState,
  CursorPermissionsState,
  SettingsMainTab,
} from '../types/types';

/**
 * [T-settings-ia] 设置页 tab 的**唯一真源**。
 *
 * 这份清单以前存在三处(SettingsSidebar 的 NAV_ITEMS、这里、
 * useSettingsController 的 KNOWN_MAIN_TABS),增删要改三个文件,
 * 而且图标和顺序已经开始各自漂移(api 一边 Key 一边 KeyRound、
 * plugins 一边 Puzzle 一边 Plug、notifications/plugins 顺序对调)。
 * 现在侧栏与 controller 都从这里派生。
 */
export type SettingsMainTabGroup = 'agent' | 'workspace' | 'system';

export type SettingsMainTabMeta = {
  id: SettingsMainTab;
  /** 英文兜底名(命令面板与无 i18n 场景使用) */
  label: string;
  /** i18n key,侧栏优先用它 */
  labelKey: string;
  group: SettingsMainTabGroup;
  keywords: string;
  icon: ComponentType<{ className?: string }>;
};

export const SETTINGS_TAB_GROUP_KEYS: Record<SettingsMainTabGroup, string> = {
  agent: 'settingsGroups.agent',
  workspace: 'settingsGroups.workspace',
  system: 'settingsGroups.system',
};

export const SETTINGS_MAIN_TABS: SettingsMainTabMeta[] = [
  // 智能体:先装好、再定档案、再接工具与技能。
  { id: 'agents', label: 'Agents', labelKey: 'mainTabs.agents', group: 'agent', keywords: 'agents subagents claude code 智能体 本机智能体', icon: Bot },
  { id: 'agentHub', label: 'Agent Hub', labelKey: 'mainTabs.agentHub', group: 'agent', keywords: 'agent hub profiles presets 智能体 档案 launch', icon: Boxes },
  { id: 'mcp', label: 'MCP', labelKey: 'mainTabs.mcp', group: 'agent', keywords: 'mcp servers model context protocol tools 工具', icon: Server },
  { id: 'skills', label: 'Skills', labelKey: 'mainTabs.skills', group: 'agent', keywords: 'skills abilities SKILL.md 技能', icon: Sparkles },

  // 工作区:外观从「系统」搬进来——它调的是这台机器的工作环境,不是系统能力。
  { id: 'appearance', label: 'Appearance', labelKey: 'mainTabs.appearance', group: 'workspace', keywords: 'appearance theme dark light language density 外观 主题 语言 密度', icon: Palette },
  { id: 'git', label: 'Git', labelKey: 'mainTabs.git', group: 'workspace', keywords: 'git github commits 提交 分支 代码仓库', icon: GitBranch },
  { id: 'tasks', label: 'Tasks', labelKey: 'mainTabs.tasks', group: 'workspace', keywords: 'tasks taskmaster 任务', icon: ListChecks },
  { id: 'browser', label: 'Browser', labelKey: 'mainTabs.browser', group: 'workspace', keywords: 'browser playwright chromium automation 浏览器', icon: MonitorPlay },
  { id: 'voice', label: 'Voice', labelKey: 'mainTabs.voice', group: 'workspace', keywords: 'voice speech dictation microphone 语音', icon: Mic },

  // 系统:插件从「智能体」搬过来——它扩的是工作台本身,不是某个 Agent。
  { id: 'api', label: 'API Tokens', labelKey: 'mainTabs.apiTokens', group: 'system', keywords: 'api tokens auth keys 密钥 令牌 接口 凭据', icon: KeyRound },
  { id: 'notifications', label: 'Notifications', labelKey: 'mainTabs.notifications', group: 'system', keywords: 'notifications alerts push 通知', icon: Bell },
  { id: 'plugins', label: 'Plugins', labelKey: 'mainTabs.plugins', group: 'system', keywords: 'plugins extensions integrations 插件', icon: Plug },
  { id: 'storage', label: 'Storage', labelKey: 'mainTabs.storage', group: 'system', keywords: 'storage cache treasury disk cleanup 存储 缓存 藏宝阁 清理', icon: HardDrive },
  { id: 'about', label: 'About', labelKey: 'mainTabs.about', group: 'system', keywords: 'about version info 关于 版本 更新', icon: Info },
];

/** 派生:给 controller 做合法性校验用,不要再手写第二份。 */
export const KNOWN_SETTINGS_MAIN_TABS: SettingsMainTab[] = SETTINGS_MAIN_TABS.map((t) => t.id);

export const DEFAULT_CODE_EDITOR_SETTINGS: CodeEditorSettingsState = {
  wordWrap: false,
  showMinimap: true,
  lineNumbers: true,
  fontSize: '14',
};

export const DEFAULT_CURSOR_PERMISSIONS: CursorPermissionsState = {
  allowedCommands: [],
  disallowedCommands: [],
  skipPermissions: false,
};
