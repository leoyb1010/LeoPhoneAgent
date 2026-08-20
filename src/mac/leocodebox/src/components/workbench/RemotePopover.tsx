import { useTranslation } from 'react-i18next';

import { Tooltip } from '../../shared/view/ui';
import { cn } from '../../lib/utils';

import { isMachineOnline, type FleetMachine } from './useFleetSnapshot';

type RemotePopoverProps = {
  open: boolean;
  onToggle: () => void;
  remotes: FleetMachine[];
  onlineCount: number;
  configured: boolean;
  onTakeOver: (machine: FleetMachine) => void;
};

/**
 * [T-fleet-demote] 远程机器从独立 Tab 降级成标题栏的一个胶囊 + 288px 弹层。
 *
 * 舰队视图原本占一个一级导航位,但日常只用来回答两个问题:几台在线、
 * 哪台有会话可接管。这两个答案放进胶囊和弹层就够,腾出的导航位给对话。
 * 接管走的仍是 FleetView 那条全量回放 + 实时跟随的链路。
 */
export default function RemotePopover({
  open,
  onToggle,
  remotes,
  onlineCount,
  configured,
  onTakeOver,
}: RemotePopoverProps) {
  const { t } = useTranslation();
  const label = configured
    ? t('workbench.remoteCapsule', { count: onlineCount, defaultValue: `远程 · ${onlineCount} 台在线` })
    : t('workbench.remoteUnconfigured', { defaultValue: '远程 · 未配置中继' });

  return (
    <span className="relative inline-flex">
      <Tooltip content={t('workbench.remoteTooltip', { defaultValue: '远程机器状态与会话接管' })} position="bottom">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={label}
          className="wb-chip-button h-[26px] rounded-full px-[11px] text-[10.5px]"
        >
          <span className="flex gap-1">
            {[0, 1, 2].map((slot) => (
              <span
                key={slot}
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  slot < onlineCount ? 'bg-primary' : 'bg-wb-faint',
                )}
              />
            ))}
          </span>
          {label}
          <span className="text-[9px] opacity-70">{open ? '▴' : '▾'}</span>
        </button>
      </Tooltip>

      {open && (
        <div
          role="dialog"
          aria-label={t('workbench.remoteTooltip', { defaultValue: '远程机器状态与会话接管' })}
          className="wb-anim-sheet absolute right-0 top-9 z-40 w-72 rounded-[14px] bg-card p-2.5 shadow-elevation-3 ring-1 ring-inset ring-border"
        >
          {remotes.length === 0 ? (
            <p className="px-2.5 py-3 text-[11px] text-muted-foreground">
              {configured
                ? t('workbench.remoteEmpty', { defaultValue: '中继上暂时没有其他机器。' })
                : t('workbench.remoteSetupHint', { defaultValue: '在 ~/.leoagent/relay.json 配置中继后,这里会列出其他 Mac。' })}
            </p>
          ) : (
            remotes.map((machine) => {
              // 胶囊上的 onlineCount 与这里的圆点、文案必须是同一个判断,
              // 否则会出现「胶囊说 2 台在线,列表里两台都写着离线」。
              const online = isMachineOnline(machine);
              const takeable = online && machine.activeCount > 0;
              return (
                <div
                  key={machine.name}
                  className="flex items-center gap-2.5 rounded-[9px] px-2.5 py-2.5 transition-colors hover:bg-muted"
                >
                  <span
                    className={cn('h-[7px] w-[7px] flex-none rounded-full', online ? 'bg-primary' : 'bg-wb-faint')}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-semibold text-foreground">{machine.name}</span>
                    <span className="mt-px block truncate text-[10px] text-wb-faint">
                      {online
                        ? t('workbench.remoteActive', {
                          count: machine.activeCount,
                          defaultValue: `${machine.activeCount} 个会话运行中`,
                        })
                        : t('workbench.remoteOffline', { defaultValue: '离线' })}
                    </span>
                  </span>
                  {takeable ? (
                    <button
                      type="button"
                      onClick={() => onTakeOver(machine)}
                      className="wb-chip-button h-[22px] px-2.5 text-[10px] font-semibold text-primary"
                    >
                      {t('workbench.takeOver', { defaultValue: '接管会话' })}
                    </button>
                  ) : (
                    <span className="font-mono text-[9.5px] text-muted-foreground">
                      {online
                        ? t('workbench.remoteIdle', { defaultValue: '空闲' })
                        : t('workbench.remoteOffline', { defaultValue: '离线' })}
                    </span>
                  )}
                </div>
              );
            })
          )}
          <p className="mx-0.5 mb-0.5 mt-2 border-t border-border pt-2 text-[10px] text-wb-faint">
            {t('workbench.takeOverHint', { defaultValue: '接管 = 全量回放 + 实时跟随,断线不丢事件' })}
          </p>
        </div>
      )}
    </span>
  );
}
