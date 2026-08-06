import type { SessionActionStripAction, SessionActionStripActionId } from '@/session/sessionOverview';

export interface MobileSessionActionProjection {
  hiddenActions: SessionActionStripAction[];
  primaryActions: SessionActionStripAction[];
}

const PRIMARY_ACTION_ORDER: readonly SessionActionStripActionId[] = ['settings', 'queue', 'files', 'search'];

export function projectMobileSessionActions(
  actions: readonly SessionActionStripAction[],
): MobileSessionActionProjection {
  const primaryActions = actions
    .filter(isMobilePrimaryAction)
    .sort((a, b) => PRIMARY_ACTION_ORDER.indexOf(a.id) - PRIMARY_ACTION_ORDER.indexOf(b.id));
  const primaryIds = new Set(primaryActions.map((action) => action.id));

  return {
    hiddenActions: actions.filter((action) => !primaryIds.has(action.id)),
    primaryActions,
  };
}

function isMobilePrimaryAction(action: SessionActionStripAction): boolean {
  if (action.id === 'settings') return true;
  if (action.id === 'usage') return false;
  if (action.id === 'queue') return !action.disabled;
  if (action.id === 'files' || action.id === 'search') return !action.disabled;
  return false;
}
