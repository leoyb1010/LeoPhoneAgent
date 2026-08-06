/**
 * Pending queue row activity state.
 *
 * 行内操作按钮只应该在“正在指向这一行”或“键盘焦点仍在这一行内”时出现。
 * 之前把 hover 写成单一 selectedClientId,只有 enter 没有 leave,鼠标移走后
 * 最后一行会永久带着插话/编辑/删除按钮,看起来像队列内容的一部分。这里把
 * hover 与 focus 拆开,让鼠标离开能清掉 hover,同时保留键盘可访问性。
 */

export interface PendingQueueRowActivityState {
  hoveredClientId: string | null;
  focusedClientId: string | null;
}

export const emptyPendingQueueRowActivityState: PendingQueueRowActivityState = {
  hoveredClientId: null,
  focusedClientId: null,
};

export function activatePendingQueueRowHover(
  state: PendingQueueRowActivityState,
  clientId: string,
  editingClientId: string | null,
): PendingQueueRowActivityState {
  if (editingClientId !== null || state.hoveredClientId === clientId) return state;
  return { ...state, hoveredClientId: clientId };
}

export function deactivatePendingQueueRowHover(
  state: PendingQueueRowActivityState,
  clientId: string,
): PendingQueueRowActivityState {
  if (state.hoveredClientId !== clientId) return state;
  return { ...state, hoveredClientId: null };
}

export function activatePendingQueueRowFocus(
  state: PendingQueueRowActivityState,
  clientId: string,
): PendingQueueRowActivityState {
  if (state.focusedClientId === clientId) return state;
  return { ...state, focusedClientId: clientId };
}

export function deactivatePendingQueueRowFocus(
  state: PendingQueueRowActivityState,
  clientId: string,
): PendingQueueRowActivityState {
  if (state.focusedClientId !== clientId) return state;
  return { ...state, focusedClientId: null };
}

export function isPendingQueueRowActive(
  state: PendingQueueRowActivityState,
  clientId: string,
): boolean {
  return state.hoveredClientId === clientId || state.focusedClientId === clientId;
}

export function prunePendingQueueRowActivity(
  state: PendingQueueRowActivityState,
  validClientIds: readonly string[],
): PendingQueueRowActivityState {
  const hasHovered =
    state.hoveredClientId === null || validClientIds.includes(state.hoveredClientId);
  const hasFocused =
    state.focusedClientId === null || validClientIds.includes(state.focusedClientId);
  if (hasHovered && hasFocused) return state;
  return {
    hoveredClientId: hasHovered ? state.hoveredClientId : null,
    focusedClientId: hasFocused ? state.focusedClientId : null,
  };
}
