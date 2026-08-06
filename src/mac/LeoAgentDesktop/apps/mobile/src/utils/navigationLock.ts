/**
 * 前进导航锁(防重复 push)。
 * ---------------------------------------------------------------------------
 * 列表页 JS 线程繁忙时(重列表 + 目标大屏 mount),点击到转场生效之间有一段
 * 可感知的延迟;用户在这个窗口里补点的每一次都会各自触发一次 router.push,
 * expo-router 不按路由去重,结果是同一个会话被连续压进导航栈 N 层,返回也要
 * 返回 N 次。锁的语义:
 *  - 同一目标(key 相同)在 SAME_TARGET_WINDOW_MS 内只放行第一次——挡住
 *    "没反应再点一下"的补点;
 *  - 任意目标在 TRANSITION_WINDOW_MS 内只放行一次——转场动画期间旧屏未被
 *    完全覆盖时误触其它行,同样不该再叠一层。
 * 被挡的点击静默丢弃(第一次点击的导航已经在路上,丢弃就是用户想要的结果)。
 *
 * 窗口只是最后防线,抑制被精确 scope 到「导航在途」期间,靠两条提前释放路径
 * (均为 review P2 反馈):
 *  - 转场动画完成(native-stack transitionEnd)即 reset——目标页可交互后的
 *    首次点击(如详情页「新建」)不被来源页设下的残留窗口误吞;
 *  - 页面从下一层返回重新获得焦点时 reset(见 createRefocusReset)——兜住
 *    transitionEnd 不触发的平台(web),「进入 → 返回 → 马上再点」不被误吞。
 * 两条路径都不触发时(极端时序)才由时间窗兜底过期。
 *
 * 纯逻辑零依赖,时间源可注入以便单测;expo-router 接入见 useGuardedPush.ts。
 */

/** 同一目标的去重窗口:覆盖"点了没反应再补点"的整个延迟区间。 */
export const SAME_TARGET_WINDOW_MS = 1000;
/** 任意前进导航之间的最小间隔:覆盖一次栈转场动画。 */
export const TRANSITION_WINDOW_MS = 650;

export interface NavigationLock {
  /** 询问一次以 key 为目标的前进导航是否放行;放行即登记为最近一次导航。 */
  shouldAllow(key: string): boolean;
  /** 清空登记(测试用;运行时窗口很短,无需主动释放)。 */
  reset(): void;
}

export interface NavigationLockOptions {
  now?: () => number;
  sameTargetWindowMs?: number;
  transitionWindowMs?: number;
}

/** 默认时间源:优先单调时钟(不受系统校时回拨影响),没有 performance 时退回 Date.now。 */
function defaultNow(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

export function createNavigationLock(options: NavigationLockOptions = {}): NavigationLock {
  const now = options.now ?? defaultNow;
  const sameTargetWindowMs = options.sameTargetWindowMs ?? SAME_TARGET_WINDOW_MS;
  const transitionWindowMs = options.transitionWindowMs ?? TRANSITION_WINDOW_MS;
  let last: { key: string; at: number } | null = null;
  return {
    shouldAllow(key: string): boolean {
      const at = now();
      if (last) {
        const elapsed = at - last.at;
        if (elapsed < 0) {
          // 时钟回拨(仅 Date.now 退路可能发生):拒绝这一次以免回拨瞬间放行第二层,
          // 但把登记时间拉回当前,避免锁死到时钟追上旧时间为止。
          last = { key: last.key, at };
          return false;
        }
        const windowMs = last.key === key ? sameTargetWindowMs : transitionWindowMs;
        if (elapsed < windowMs) return false;
      }
      last = { key, at };
      return true;
    },
    reset(): void {
      last = null;
    },
  };
}

/** 全 app 共享的一把前进导航锁:同一时刻只应发生一次前进转场,跨页面共享才能挡住跨入口连点。 */
export const forwardNavigationLock = createNavigationLock();

/**
 * 生成 focus 回调:首次 focus(screen 被挂载进入,包括被 push 出来的目标页)跳过,
 * 之后每次重新获得焦点(从下一层返回)都释放锁,让用户返回后能立即再次导航。
 * 首次必须跳过:目标页挂载时的 focus 事件发生在转场开始,若此刻清锁,发起页
 * 还在排队的补点 press 会穿透守卫、把同一页压进第二层——正是本锁要防的场景。
 */
export function createRefocusReset(lock: NavigationLock): () => void {
  let mounted = false;
  return () => {
    if (!mounted) {
      mounted = true;
      return;
    }
    lock.reset();
  };
}

/**
 * 把 router.push 的目标序列化成锁 key。
 * string 形式直接用;object 形式取 pathname + 排序后的 params(顺序无关),
 * 保证同一行两次点击生成的 key 逐字节一致。
 */
export function navigationTargetKey(href: unknown): string {
  if (typeof href === 'string') return href;
  if (href && typeof href === 'object') {
    const { pathname, params } = href as { pathname?: unknown; params?: unknown };
    const path = typeof pathname === 'string' ? pathname : '';
    if (!params || typeof params !== 'object') return path;
    const parts = Object.entries(params as Record<string, unknown>)
      .filter(([, value]) => value !== undefined)
      // 值走 JSON.stringify 转义,避免含 "&" / "=" 的值与相邻键值对产生 key 碰撞。
      .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`)
      .sort();
    return `${path}?${parts.join('&')}`;
  }
  return String(href);
}
