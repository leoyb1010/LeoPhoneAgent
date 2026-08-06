import { useSyncExternalStore } from 'react';

/**
 * useUpdateBannerDismiss — 侧栏自动更新提示框(UpdateBanner)的临时隐藏态。
 *
 * 场景:更新就绪(status='ready')时 banner 自动出现,用户想暂时不看可以点 X 关掉。
 * 关掉后头像行的 Flame 按钮涂黑,点击可以把 banner 再唤回来。
 *
 * 语义:
 * - **仅本次进程内存**:重启后回到 false(update 是关键状态,不能永久隐藏)。
 * - **新更新到达自动 reset**:dismiss 时会记录当时的 (status, version) 快照;
 *   消费方通过 isNewUpdateAfterDismiss(status, version) 判断是否有新更新到达
 *   (对比快照),只在真的发生变化时 restore()——这样 UpdateBanner 在
 *   /settings 往返后 remount、useUpdateStatus() 经历 idle→ready 的初始水合
 *   时,不会因为「版本和之前 dismiss 时一样」而误 restore。
 * - 模块级 singleton store(useSyncExternalStore),让 UpdateBanner 与
 *   UserInfoSection 无需 context / prop-drill 就能共享同一状态。
 */

interface DismissState {
  dismissed: boolean;
  dismissedStatus: string | null;
  dismissedVersion: string | null;
}

let state: DismissState = {
  dismissed: false,
  dismissedStatus: null,
  dismissedVersion: null,
};
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((fn) => fn());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return state.dismissed;
}

export function dismissUpdateBanner(currentStatus: string, currentVersion: string | null) {
  if (state.dismissed) return;
  state = { dismissed: true, dismissedStatus: currentStatus, dismissedVersion: currentVersion };
  emit();
}

export function restoreUpdateBanner() {
  if (!state.dismissed) return;
  state = { dismissed: false, dismissedStatus: null, dismissedVersion: null };
  emit();
}

/**
 * Returns true if a genuinely new update has arrived since the user dismissed
 * the banner — i.e. the current (status, version) differs from the snapshot
 * captured at dismiss time. Returns false when not dismissed, so callers can
 * unconditionally gate on this without an extra dismissed check.
 *
 * Guards against transient 'idle': useUpdateStatus() starts at 'idle' before
 * getUpdateStatus() resolves on remount, so we must not treat idle/error as a
 * new-update signal — only 'ready' and 'superseding' represent active updates.
 */
export function isNewUpdateAfterDismiss(currentStatus: string, currentVersion: string | null): boolean {
  if (!state.dismissed) return false;
  if (currentStatus !== 'ready' && currentStatus !== 'superseding') return false;
  return currentStatus !== state.dismissedStatus || currentVersion !== state.dismissedVersion;
}

export function useUpdateBannerDismiss() {
  const isDismissed = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    dismissed: isDismissed,
    dismiss: dismissUpdateBanner,
    restore: restoreUpdateBanner,
    isNewUpdateAfterDismiss,
  };
}
