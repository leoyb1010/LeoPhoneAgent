import { Moon, Settings, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Tooltip } from '../../shared/view/ui';
import { useTheme } from '../../contexts/ThemeContext';

import RemotePopover from './RemotePopover';
import type { FleetMachine } from './useFleetSnapshot';

type WorkbenchTitleBarProps = {
  localName: string;
  remotes: FleetMachine[];
  onlineCount: number;
  fleetConfigured: boolean;
  remoteOpen: boolean;
  onToggleRemote: () => void;
  onTakeOver: (machine: FleetMachine) => void;
  onOpenLeoapi: () => void;
  onOpenPalette: () => void;
  onOpenSettings: () => void;
};

/**
 * 46px 标题栏 —— 工作台唯一的常驻控件带。
 *
 * 这里刻意**没有导航**:9 项侧边导航栏被删掉之后,标题栏只负责身份
 * (本机是谁)与四个全局工具(远程 / Leoapi / ⌘K / 外观 / 设置)。
 * 任何"去某个页面"的动作都归 ⌘K。
 */
export default function WorkbenchTitleBar({
  localName,
  remotes,
  onlineCount,
  fleetConfigured,
  remoteOpen,
  onToggleRemote,
  onTakeOver,
  onOpenLeoapi,
  onOpenPalette,
  onOpenSettings,
}: WorkbenchTitleBarProps) {
  const { t } = useTranslation();
  const { isDarkMode, toggleDarkMode } = useTheme();

  return (
    <header className="wb-titlebar relative z-40 flex h-[46px] flex-none items-center border-b border-border px-[18px] transition-colors duration-slow">
      {/* macOS 的红绿灯由系统绘制在 x=18,这里只给它让位。 */}
      <span aria-hidden className="w-[62px] flex-none" />
      <span className="font-mono text-[10.5px] tracking-[0.24em] text-wb-faint">LEO</span>
      <span className="ml-2.5 truncate text-[11px] text-muted-foreground">
        {t('workbench.localMachine', { name: localName, defaultValue: `本机 · ${localName}` })}
      </span>

      <div className="flex-1" />

      <div className="flex items-center gap-3">
        <RemotePopover
          open={remoteOpen}
          onToggle={onToggleRemote}
          remotes={remotes}
          onlineCount={onlineCount}
          configured={fleetConfigured}
          onTakeOver={onTakeOver}
        />

        <Tooltip content={t('workbench.leoapiTooltip', { defaultValue: 'Leoapi · 本机模型网关' })} position="bottom">
          <button
            type="button"
            onClick={onOpenLeoapi}
            aria-label="Leoapi"
            className="wb-chip-button h-[30px] px-[11px] text-[11px] font-semibold"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden>
              <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
              <circle cx="15" cy="7" r="2.2" />
              <circle cx="9" cy="17" r="2.2" />
            </svg>
            Leoapi
          </button>
        </Tooltip>

        <Tooltip content={t('workbench.paletteTooltip', { defaultValue: '命令面板 · 新会话 / 快速任务 / 导航' })} position="bottom">
          <button
            type="button"
            onClick={onOpenPalette}
            aria-label={t('workbench.paletteTooltip', { defaultValue: '命令面板' })}
            className="wb-chip-button h-[30px] px-2.5 font-mono text-[10px] text-wb-faint"
          >
            ⌘K
          </button>
        </Tooltip>

        <Tooltip content={t('workbench.themeTooltip', { defaultValue: '切换外观' })} position="bottom">
          <button
            type="button"
            onClick={toggleDarkMode}
            aria-label={t('workbench.themeTooltip', { defaultValue: '切换外观' })}
            className="wb-chip-button h-[30px] w-[30px]"
          >
            {isDarkMode ? <Sun className="h-[15px] w-[15px]" /> : <Moon className="h-[15px] w-[15px]" />}
          </button>
        </Tooltip>

        <Tooltip content={t('workbench.settingsTooltip', { defaultValue: '设置 ⌘,' })} position="bottom">
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label={t('workbench.settingsTooltip', { defaultValue: '设置' })}
            className="wb-chip-button wb-gear h-[30px] w-[30px]"
          >
            <Settings className="h-[15px] w-[15px]" />
          </button>
        </Tooltip>
      </div>
    </header>
  );
}
