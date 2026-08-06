/**
 * scrollAnchoringDetect
 * ---------------------------------------------------------------------------
 * F-SYNC-2 与浏览器 scroll anchoring(`overflow-anchor`)双补偿防御的判定核心。
 *
 * 背景:Chromium 顶部 prepend 内容时会自动调整 scrollTop 让 viewport 锚点元素
 * 视觉位置不动(scroll anchoring)。这跟 F-SYNC-2 的 `scrollTop += delta` 做
 * 同一件事,两者叠加会让 viewport 被推到底。
 *
 * 判断原理:anchoring 真生效时,scrollTop 增量应该 ≈ 内容高度增量(delta) —
 * 因为浏览器加的就是用来"补偿锚点元素被推下去那段高度"。其它来源的 scrollTop
 * 增量(用户手动下滑、其它 programmatic scroll)是随意值,极少恰好 ≈ delta。
 *
 * 抽成纯函数为了:
 *  - 单测覆盖 — F-SYNC-2 effect 嵌的 DOM/React 不便直接测
 *  - 边界条件清晰 — delta<=0 / 容差 / 反向滚动 都能覆盖
 *
 * ── Known limitation:用户在 onLoadMore IPC 期间手动滚动 ──
 * 快照(prevScrollTop)在 handleScroll 触发 onLoadMore 那一刻取,effect 在 IPC
 * 返回 + React commit 之后跑;期间若用户手动滚动 N px 且 N > tolerance,会让
 * scrollTopDelta 偏离 heightDelta 超过容差 → 误判 anchoring **未**生效 →
 * 走手动补偿 → 与浏览器 anchoring 实际加的 delta 叠加 → 双补偿,viewport 飙底。
 * 触发条件极窄(异步 onLoadMore + 用户在 IPC 窗口内手滑 >50px),expandWindow
 * 的同步路径不受影响。结构性修法是把检测放进 useLayoutEffect 在 commit 同步
 * 重读 scrollTop,关掉 IPC race 窗口,留给后续 PR。
 */

/** anchoring 检测容差(px)。锚点元素不完美贴顶时浏览器加的 scrollTop 与
 *  delta 可能差几十 px,留出空间避免误判 anchoring 没生效。 */
export const ANCHORING_TOLERANCE_PX = 50;

export interface AnchoringDetectArgs {
  /** prepend 触发那一刻(handleScroll 设 prevScrollHeightRef 时)的 scrollHeight 快照 */
  prevScrollHeight: number;
  /** prepend 触发那一刻的 scrollTop 快照 */
  prevScrollTop: number;
  /** F-SYNC-2 effect 跑时的当前 scrollHeight(prepend 已应用) */
  currentScrollHeight: number;
  /** F-SYNC-2 effect 跑时的当前 scrollTop */
  currentScrollTop: number;
  /** 容差,默认 ANCHORING_TOLERANCE_PX */
  tolerance?: number;
}

/**
 * 判断浏览器 scroll anchoring 是否已经替我们做了 scrollTop 补偿。
 * 返回 true → F-SYNC-2 应该 skip 手动 `scrollTop += delta`,避免双补偿。
 * 返回 false → anchoring 没生效,F-SYNC-2 应该手动补偿。
 */
export function detectScrollAnchoringApplied({
  prevScrollHeight,
  prevScrollTop,
  currentScrollHeight,
  currentScrollTop,
  tolerance = ANCHORING_TOLERANCE_PX,
}: AnchoringDetectArgs): boolean {
  const heightDelta = currentScrollHeight - prevScrollHeight;
  // delta<=0 不是 prepend(可能是内容收缩),anchoring 不应该参与
  if (heightDelta <= 0) return false;
  const scrollTopDelta = currentScrollTop - prevScrollTop;
  return Math.abs(scrollTopDelta - heightDelta) < tolerance;
}
