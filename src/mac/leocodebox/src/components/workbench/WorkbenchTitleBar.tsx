import { Plus, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Tooltip } from '../../shared/view/ui';

import RemotePopover from './RemotePopover';
import type { FleetMachine } from './useFleetSnapshot';

type WorkbenchTitleBarProps = {
  /** 清空当前会话语境并进入唯一的新任务入口。 */
  onStartNewTask: () => void;
  newTaskActive: boolean;
  localName: string;
  remotes: FleetMachine[];
  onlineCount: number;
  fleetConfigured: boolean;
  remoteOpen: boolean;
  onToggleRemote: () => void;
  onTakeOver: (machine: FleetMachine) => void;
  onOpenSettings: () => void;
};

/**
 * 46px 标题栏 —— 只保留三个应用级事实:新任务、设备、设置。
 * LeoAPI、外观、命令面板和 Harness 都有自己的唯一归属,不能继续在标题栏复制入口。
 */
export default function WorkbenchTitleBar({
  onStartNewTask,
  newTaskActive,
  localName,
  remotes,
  onlineCount,
  fleetConfigured,
  remoteOpen,
  onToggleRemote,
  onTakeOver,
  onOpenSettings,
}: WorkbenchTitleBarProps) {
  const { t } = useTranslation();

  return (
    <header className="wb-titlebar relative z-40 flex h-[46px] flex-none items-center border-b border-border px-[18px] transition-colors duration-slow">
      {/* macOS 的红绿灯由系统绘制在 x=18,这里只给它让位。 */}
      <span aria-hidden className="w-[62px] flex-none" />
      <span className="font-mono text-[10.5px] tracking-[0.24em] text-wb-faint">LEO</span>

      <Tooltip content={t('workbench.newTaskTooltip', { defaultValue: '新任务 · 选择 Agent、项目和设备' })} position="bottom">
        <button
          type="button"
          onClick={onStartNewTask}
          aria-label={t('workbench.newTask', { defaultValue: '新任务' })}
          aria-current={newTaskActive ? 'page' : undefined}
          className={`wb-chip-button ml-3 h-[30px] gap-1.5 px-3 text-[11px] font-semibold ${newTaskActive ? 'bg-primary/[0.09] text-primary' : 'text-foreground'}`}
        >
          <Plus className="h-3.5 w-3.5" />
          {t('workbench.newTask', { defaultValue: '新任务' })}
        </button>
      </Tooltip>

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
