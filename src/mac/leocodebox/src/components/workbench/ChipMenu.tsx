import { useEffect, useRef, useState, type ReactNode } from 'react';

import { cn } from '../../lib/utils';
import { Tooltip } from '../../shared/view/ui';

export type ChipMenuOption = {
  value: string;
  label: string;
  /** 次要说明,渲染在标题下方(版本号、权限含义等)。 */
  desc?: string;
  /** 左侧图标槽:Agent 用徽标,权限模式用彩点。 */
  icon?: ReactNode;
  disabled?: boolean;
};

type ChipMenuProps = {
  value: string;
  options: ChipMenuOption[];
  onSelect: (value: string) => void;
  /** 芯片上显示的内容(通常是当前值的短标签)。 */
  children: ReactNode;
  tooltip: string;
  ariaLabel: string;
  /** 菜单底部的一行说明或跳转入口。 */
  footer?: ReactNode;
  className?: string;
  menuClassName?: string;
  align?: 'left' | 'right';
};

/**
 * 指挥条上的芯片式下拉。
 *
 * 这些控件一开始是"点一下换下一档"的循环按钮 —— 少一层菜单,但你必须记住
 * 一共有几档、当前在第几档,而且回不去上一档。改成菜单之后每一档都是可见、
 * 可直达的,权限模式这种"选错代价很大"的开关尤其需要看得见再点。
 * 四个芯片(Agent / 目标 / 权限 / 推理强度)共用这一个组件。
 */
export default function ChipMenu({
  value,
  options,
  onSelect,
  children,
  tooltip,
  ariaLabel,
  footer,
  className,
  menuClassName,
  align = 'left',
}: ChipMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onAway = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onAway);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onAway);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span ref={ref} className="relative inline-flex flex-none">
      <Tooltip content={tooltip} position="bottom">
        <button
          type="button"
          onClick={() => setOpen((previous) => !previous)}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={ariaLabel}
          className={cn('wb-chip-button', className)}
        >
          {children}
          <span aria-hidden className="text-[8.5px] text-wb-faint">{open ? '▲' : '▼'}</span>
        </button>
      </Tooltip>

      {open && (
        <span
          role="menu"
          className={cn(
            'wb-anim-sheet absolute top-11 z-[60] block w-56 rounded-xl bg-card p-1.5 shadow-elevation-3 ring-1 ring-inset ring-border',
            align === 'right' ? 'right-0' : 'left-0',
            menuClassName,
          )}
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={option.value === value}
              disabled={option.disabled}
              onClick={() => { onSelect(option.value); setOpen(false); }}
              className={cn(
                'flex w-full cursor-pointer items-center gap-2.5 rounded-lg border-none px-2.5 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                option.value === value ? 'bg-muted' : 'bg-transparent hover:bg-accent/60',
              )}
            >
              {option.icon}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-semibold text-foreground">{option.label}</span>
                {option.desc && <span className="block truncate text-[9.5px] text-wb-faint">{option.desc}</span>}
              </span>
              {option.value === value && <span aria-hidden className="text-[11px] text-primary">✓</span>}
            </button>
          ))}
          {footer}
        </span>
      )}
    </span>
  );
}
