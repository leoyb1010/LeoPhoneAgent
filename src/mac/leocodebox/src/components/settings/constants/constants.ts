import type { ComponentType } from 'react';
import {
  Bell,
  Bot,
  Boxes,
  GitBranch,
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
  { id: 'agents', label: 'Agents', labelKey: 'mainTabs.agents', group: 'agent', keywords: 'agents subagents claude code 智能体', icon: Bot },
  { id: 'agentHub', label: 'Agent Hub', labelKey: 'mainTabs.agentHub', group: 'agent', keywords: 'agent hub profiles presets 智能体 档案 launch', icon: Boxes },
  { id: 'skills', label: 'Skills', labelKey: 'mainTabs.skills', group: 'agent', keywords: 'skills abilities SKILL.md 技能', icon: Sparkles },
  { id: 'mcp', label: 'MCP', labelKey: 'mainTabs.mcp', group: 'agent', keywords: 'mcp servers model context protocol tools 工具', icon: Server },
  { id: 'plugins', label: 'Plugins', labelKey: 'mainTabs.plugins', group: 'agent', keywords: 'plugins extensions integrations 插件', icon: Plug },

  { id: 'git', label: 'Git', labelKey: 'mainTabs.git', group: 'workspace', keywords: 'git github commits 提交 分支', icon: GitBranch },
  { id: 'tasks', label: 'Tasks', labelKey: 'mainTabs.tasks', group: 'workspace', keywords: 'tasks taskmaster 任务', icon: ListChecks },
  { id: 'browser', label: 'Browser', labelKey: 'mainTabs.browser', group: 'workspace', keywords: 'browser playwright chromium automation 浏览器', icon: MonitorPlay },
  { id: 'voice', label: 'Voice', labelKey: 'mainTabs.voice', group: 'workspace', keywords: 'voice speech dictation microphone 语音', icon: Mic },

  { id: 'api', label: 'API Tokens', labelKey: 'mainTabs.apiTokens', group: 'system', keywords: 'api tokens auth keys 密钥 令牌', icon: KeyRound },
  { id: 'appearance', label: 'Appearance', labelKey: 'mainTabs.appearance', group: 'system', keywords: 'appearance theme dark light language 外观 主题 语言', icon: Palette },
  { id: 'notifications', label: 'Notifications', labelKey: 'mainTabs.notifications', group: 'system', keywords: 'notifications alerts push 通知', icon: Bell },
  { id: 'about', label: 'About', labelKey: 'mainTabs.about', group: 'system', keywords: 'about version info 关于 版本', icon: Info },
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
