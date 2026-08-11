import {
  Activity,
  FolderKanban,
  GitBranch,
  House,
  LayoutGrid,
  MessageSquare,
  MonitorCog,
  Settings,
  SlidersHorizontal,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../lib/utils';
import { Tooltip } from '../../shared/view/ui';
import type { AppTab } from '../../types/app';

type DesktopAppRailProps = {
  activeTab: AppTab;
  onTabChange: (tab: AppTab) => void;
  onShowSettings: () => void;
  onShowLeoapi: () => void;
  onShowLocalLog: () => void;
};

const primaryItems = [
  { id: 'dashboard', labelKey: 'workspaceShell.dashboard', icon: House, tab: 'dashboard' as AppTab, fallback: '首页' },
  { id: 'chat', labelKey: 'workspaceShell.chat', icon: MessageSquare, tab: 'chat' as AppTab, fallback: '对话' },
  { id: 'fleet', labelKey: 'tabs.fleet', icon: MonitorCog, tab: 'fleet' as AppTab, fallback: 'Mac 控制台' },
  { id: 'missions', labelKey: 'workspaceShell.missions', icon: LayoutGrid, tab: 'missions' as AppTab, fallback: '快速任务' },
  { id: 'projects', labelKey: 'workspaceShell.projects', icon: FolderKanban, tab: 'files' as AppTab, fallback: '项目' },
];

export default function DesktopAppRail({
  activeTab,
  onTabChange,
  onShowSettings,
  onShowLeoapi,
  onShowLocalLog,
}: DesktopAppRailProps) {
  const { t } = useTranslation();
  return (
    <aside className="leocodebox-app-rail hidden h-full w-[58px] flex-shrink-0 flex-col items-center border-r border-border md:flex">
      <div className="flex h-14 w-full items-center justify-center border-b border-border/70">
        <img src="/logo-32.png" alt="leocodebox" className="h-7 w-7 rounded-md" />
      </div>

      <nav className="flex w-full flex-1 flex-col items-center gap-1 px-2 py-3" aria-label={t('workspaceShell.navigationLabel')}>
        {primaryItems.map((item) => {
          const Icon = item.icon;
          const label = t(item.labelKey, { defaultValue: item.fallback });
          const isActive = activeTab === item.tab;
          return (
            <Tooltip key={item.id} content={label} position="right">
              <button
                type="button"
                aria-label={label}
                aria-current={isActive ? 'page' : undefined}
                onClick={() => onTabChange(item.tab)}
                className={cn('leocodebox-rail-button', isActive && 'is-active')}
              >
                <Icon className="h-[18px] w-[18px]" strokeWidth={isActive ? 2.1 : 1.7} />
                <span>{label}</span>
              </button>
            </Tooltip>
          );
        })}

        <div className="my-2 h-px w-7 bg-border/70" />

        <Tooltip content={t('workspaceShell.changes', { defaultValue: '变更' })} position="right">
          <button type="button" aria-label={t('workspaceShell.changes', { defaultValue: '变更' })} onClick={() => onTabChange('git')} className={cn('leocodebox-rail-button', activeTab === 'git' && 'is-active')}>
            <GitBranch className="h-[18px] w-[18px]" strokeWidth={activeTab === 'git' ? 2.1 : 1.7} />
            <span>{t('workspaceShell.changes', { defaultValue: '变更' })}</span>
          </button>
        </Tooltip>

        <Tooltip content={t('workspaceShell.localLog')} position="right">
          <button type="button" aria-label={t('workspaceShell.localLog')} onClick={onShowLocalLog} className="leocodebox-rail-button">
            <Activity className="h-[18px] w-[18px]" strokeWidth={1.7} />
            <span>{t('workspaceShell.log')}</span>
          </button>
        </Tooltip>
        <Tooltip content="Leoapi" position="right">
          <button type="button" aria-label="Leoapi" onClick={onShowLeoapi} className="leocodebox-rail-button">
            <SlidersHorizontal className="h-[18px] w-[18px]" strokeWidth={1.7} />
            <span>Leoapi</span>
          </button>
        </Tooltip>
      </nav>

      <div className="flex w-full flex-col items-center gap-1 border-t border-border/70 px-2 py-3">
        <Tooltip content={t('workspaceShell.settings')} position="right">
          <button type="button" aria-label={t('workspaceShell.settings')} onClick={onShowSettings} className="leocodebox-rail-button">
            <Settings className="h-[18px] w-[18px]" strokeWidth={1.7} />
            <span>{t('workspaceShell.settings')}</span>
          </button>
        </Tooltip>
        <span className="mt-1 h-1.5 w-1.5 rounded-full bg-success" title={t('workspaceShell.serviceHealthy')} />
      </div>
    </aside>
  );
}
