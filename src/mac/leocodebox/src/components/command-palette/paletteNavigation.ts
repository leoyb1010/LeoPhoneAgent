import type { TFunction } from 'i18next';

import type { AppTab } from '../../types/app';
import { SETTINGS_MAIN_TABS } from '../settings/constants/constants';

export const NAV_TABS: Array<{ id: AppTab; labelKey: string; keywords: string }> = [
  { id: 'dashboard', labelKey: 'commandPalette.goConsole', keywords: 'new task 新任务 agent 项目 设备' },
  { id: 'collections', labelKey: 'commandPalette.goCollections', keywords: 'treasury library collections 藏宝阁 收藏 资料 收集 阅读' },
  { id: 'chat', labelKey: 'commandPalette.goChat', keywords: 'chat messages conversation' },
  { id: 'files', labelKey: 'commandPalette.goFiles', keywords: 'files file tree explorer' },
  { id: 'shell', labelKey: 'commandPalette.goShell', keywords: 'shell terminal console' },
  { id: 'git', labelKey: 'commandPalette.goGit', keywords: 'git diff branches' },
  { id: 'tasks', labelKey: 'commandPalette.goTasks', keywords: 'tasks taskmaster' },
  // 快速任务从一级导航位搬到这里 —— 它一天用不到几次,不值一个常驻入口。
  { id: 'missions', labelKey: 'commandPalette.goMissions', keywords: 'missions quick tasks 快速任务 任务板' },
];

export function getSettingsPaletteItems(t: TFunction) {
  return SETTINGS_MAIN_TABS.map((entry) => ({
    ...entry,
    label: t(`settings:${entry.labelKey}`, { defaultValue: entry.label }),
  }));
}
