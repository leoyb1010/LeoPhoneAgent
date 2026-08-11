import {
  Brain,
  Eye,
  Languages,
  Mic,
} from 'lucide-react';

import type { PreferenceToggleItem } from './types';

export const HANDLE_POSITION_STORAGE_KEY = 'quickSettingsHandlePosition';

export const DEFAULT_HANDLE_POSITION = 50;
export const HANDLE_POSITION_MIN = 10;
export const HANDLE_POSITION_MAX = 90;
export const DRAG_THRESHOLD_PX = 5;

export const SETTING_ROW_CLASS =
  'flex items-center justify-between p-3 rounded-lg bg-muted/60 hover:bg-accent transition-colors border border-transparent hover:border-border';

export const TOGGLE_ROW_CLASS = `${SETTING_ROW_CLASS} cursor-pointer`;

export const CHECKBOX_CLASS =
  'h-4 w-4 rounded-md border-border dark:border-border text-info dark:text-info focus:ring-info focus:ring-2 dark:focus:ring-info bg-muted dark:bg-muted checked:bg-info dark:checked:bg-info';

export const TOOL_DISPLAY_TOGGLES: PreferenceToggleItem[] = [
  {
    key: 'showRawParameters',
    labelKey: 'quickSettings.showRawParameters',
    icon: Eye,
  },
  {
    key: 'showThinking',
    labelKey: 'quickSettings.showThinking',
    icon: Brain,
  },
];

export const INPUT_SETTING_TOGGLES: PreferenceToggleItem[] = [
  {
    key: 'sendByCtrlEnter',
    labelKey: 'quickSettings.sendByCtrlEnter',
    icon: Languages,
  },
  {
    key: 'voiceEnabled',
    labelKey: 'quickSettings.voiceEnabled',
    icon: Mic,
  },
];
