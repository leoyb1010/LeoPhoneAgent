/**
 * useHoverOpenMenu —— 让 Radix DropdownMenu「鼠标移上去就展开」的受控开合 hook。
 * ---------------------------------------------------------------------------
 * Radix 的 DropdownMenu 默认点击才展开。侧栏段头的「整理侧边栏」(SidebarFilterPopover)
 * 与「远程机器切换」(MachineSwitcherMenu)希望 hover 触发按钮即展开、移开即收起。
 *
 * 行为:
 *   - hover 触发按钮 → 短延迟后 open(openDelay,防手滑扫过误开);
 *   - 移开触发按钮 / 菜单内容 → 短延迟后 close(closeDelay,给「触发按钮→内容」
 *     之间的间隙留出移动时间,进入内容会 cancelClose);
 *   - 点击触发按钮**只开不关**:已展开时点击不会把菜单点掉,保持触发态
 *     (见 triggerProps.onPointerDown + contentProps.onInteractOutside);未展开时点击照常打开;
 *   - 键盘仍可正常开合(走 Radix onOpenChange);
 *   - 选中项 / Esc / 点击外部(触发按钮以外) / 移开由 Radix onOpenChange(false) / scheduleClose 正常关闭。
 *
 * 「点击不关闭」为何要两处配合(缺一仍会关):已展开时点击触发按钮,Radix 有**两条**独立关闭路径:
 *   1. 触发按钮自身的 toggle:DropdownMenuTrigger 用
 *      `composeEventHandlers(props.onPointerDown, radixToggleHandler)`——我们挂的 onPointerDown 先跑,
 *      open 时 preventDefault 会让 composeEventHandlers 跳过 Radix 内部那次 onOpenToggle(会在已开时关闭);
 *   2. 非模态(modal={false})Content 的 DismissableLayer:它在 document 上监听 pointerdown,触发按钮不在
 *      Content 的 React 子树里 → 被判为「点击外部」→ onInteractOutside → 未 preventDefault 就 onDismiss →
 *      onOpenChange(false) 关闭。故 contentProps.onInteractOutside 在「外部点击目标落在触发按钮内」时
 *      preventDefault,掐掉这条 dismiss(react-dismissable-layer:仅当 `!event.defaultPrevented` 才 onDismiss)。
 * 两条都拦住,已展开时点击触发按钮才真正保持展开;未展开时(open=false)两处都放行,点击照常打开。
 * 触发按钮的 DOM 通过 triggerRef 拿到(消费方须把 triggerRef 挂到触发按钮上)。
 *
 * 子菜单(DropdownMenuSub)难点:SubContent 经 Portal 渲染,不在主 Content 的 DOM
 * 子树里,鼠标从主 Content 移入 SubContent 会触发主 Content 的 onMouseLeave → 误关。
 * 解法:把同一套 hoverAreaProps(onMouseEnter=cancelClose / onMouseLeave=scheduleClose)
 * 通过 HoverMenuAreaContext 也挂到每个 SubContent 上——离开主 Content 排的 close 会被
 * SubContent 的 enter 立刻取消,菜单树内移动不会关闭。
 *
 * a11y:hover 展开时 preventDefault 掉 Radix 的 openAutoFocus,避免把焦点/滚动
 * 抢进菜单(纯 hover 不应夺焦);点击 / 键盘展开时保留默认自动聚焦以便方向键导航。
 */

import {
  createContext,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

export interface HoverAreaProps {
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

/** 触发按钮专用:在 HoverAreaProps 之上追加 onPointerDown(实现「点击只开不关」)。 */
export interface HoverTriggerProps extends HoverAreaProps {
  onPointerDown: (event: ReactPointerEvent) => void;
}

/**
 * Radix DismissableLayer 的 onInteractOutside 事件(PointerDownOutside / FocusOutside)最小形状。
 * 只用到 detail.originalEvent.target(判定点击目标)与 preventDefault(掐掉 dismiss)。
 */
type OutsideInteractEvent = {
  detail: { originalEvent: { target: EventTarget | null } };
  preventDefault: () => void;
};

export interface HoverOpenMenu {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * 挂在触发按钮上的 ref —— 供 contentProps.onInteractOutside 判定「外部点击」是否落在触发按钮内,
   * 是则掐掉 DismissableLayer 的 dismiss(见文件头「点击不关闭」说明)。消费方必须挂上。
   */
  triggerRef: RefObject<HTMLElement | null>;
  /** 挂在 DropdownMenuTrigger 的子按钮上(含「点击只开不关」的 onPointerDown)。 */
  triggerProps: HoverTriggerProps;
  /** 挂在主 DropdownMenuContent 上(含防夺焦 + 防触发按钮点击 dismiss)。 */
  contentProps: HoverAreaProps & {
    onOpenAutoFocus: (event: Event) => void;
    onCloseAutoFocus: (event: Event) => void;
    onInteractOutside: (event: OutsideInteractEvent) => void;
  };
  /** 挂在每个 DropdownMenuSubContent 上,避免移入子菜单被误关(见文件头说明)。 */
  hoverAreaProps: HoverAreaProps;
}

/** 供 SubContent 读取 hoverAreaProps(跨 Portal 仍能透传 React context)。 */
export const HoverMenuAreaContext = createContext<HoverAreaProps | null>(null);

export function useHoverMenuArea(): HoverAreaProps | null {
  return useContext(HoverMenuAreaContext);
}

export function useHoverOpenMenu(opts?: { openDelay?: number; closeDelay?: number }): HoverOpenMenu {
  const openDelay = opts?.openDelay ?? 90;
  const closeDelay = opts?.closeDelay ?? 160;

  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // hover 展开标记:用于在 onOpenAutoFocus 里决定是否 preventDefault(纯 hover 不夺焦)。
  const openedViaHover = useRef(false);

  const clearOpenTimer = () => {
    if (openTimer.current) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  };
  const clearCloseTimer = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  // 卸载时清掉挂起的定时器,避免对已卸载组件 setState。
  useEffect(() => () => {
    clearOpenTimer();
    clearCloseTimer();
  }, []);

  const scheduleOpen = useCallback(() => {
    clearCloseTimer();
    if (openTimer.current) return;
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      openedViaHover.current = true;
      setOpen(true);
    }, openDelay);
  }, [openDelay]);

  const scheduleClose = useCallback(() => {
    clearOpenTimer();
    if (closeTimer.current) return;
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
    }, closeDelay);
  }, [closeDelay]);

  const cancelClose = useCallback(() => {
    clearCloseTimer();
  }, []);

  const onOpenChange = useCallback((next: boolean) => {
    clearOpenTimer();
    clearCloseTimer();
    // 点击 / 键盘 / 主动关闭走这里:非 hover 开,允许 Radix 默认自动聚焦。
    if (next) openedViaHover.current = false;
    setOpen(next);
  }, []);

  // 「点击只开不关」:已展开时,拦掉主键 pointerdown,阻止 Radix Trigger 的 toggle 关闭
  // (见文件头说明)。未展开时放行,让点击照常打开(与 hover 打开互不冲突)。
  const onTriggerPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      if (open && event.button === 0 && !event.ctrlKey) {
        event.preventDefault();
      }
    },
    [open],
  );

  // 「点击只开不关」第二条路径:非模态 Content 的 DismissableLayer 会把「点击触发按钮」判为点击外部并
  // 关闭菜单。若外部点击目标落在触发按钮内,preventDefault 掐掉这条 dismiss(见文件头)。点击真正的外部
  // (触发按钮以外)不 preventDefault,仍正常关闭。
  const onInteractOutside = useCallback((event: OutsideInteractEvent) => {
    const target = event.detail.originalEvent.target;
    if (target instanceof Node && triggerRef.current?.contains(target)) {
      event.preventDefault();
    }
  }, []);

  const onOpenAutoFocus = useCallback((event: Event) => {
    if (openedViaHover.current) event.preventDefault();
  }, []);
  const onCloseAutoFocus = useCallback((event: Event) => {
    if (openedViaHover.current) event.preventDefault();
  }, []);

  const hoverAreaProps: HoverAreaProps = {
    onMouseEnter: cancelClose,
    onMouseLeave: scheduleClose,
  };

  return {
    open,
    onOpenChange,
    triggerRef,
    triggerProps: {
      onMouseEnter: scheduleOpen,
      onMouseLeave: scheduleClose,
      onPointerDown: onTriggerPointerDown,
    },
    contentProps: { ...hoverAreaProps, onOpenAutoFocus, onCloseAutoFocus, onInteractOutside },
    hoverAreaProps,
  };
}
