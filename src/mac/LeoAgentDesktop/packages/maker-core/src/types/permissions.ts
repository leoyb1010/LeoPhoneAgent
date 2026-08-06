export const SESSION_PERMISSION_DESTINATION = 'session' as const;

export interface SessionPermissionUpdate extends Record<string, unknown> {
  destination: typeof SESSION_PERMISSION_DESTINATION;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function createSessionPermissionUpdate(
  fields: Record<string, unknown> = {},
): SessionPermissionUpdate {
  return {
    ...fields,
    destination: SESSION_PERMISSION_DESTINATION,
  };
}

export function coerceSessionPermissionUpdates(
  updates?: readonly unknown[] | null,
): SessionPermissionUpdate[] {
  if (!Array.isArray(updates)) return [];
  return updates.flatMap((update) =>
    isRecord(update) ? [createSessionPermissionUpdate(update)] : [],
  );
}

export function isSessionPermissionUpdate(update: unknown): update is SessionPermissionUpdate {
  return isRecord(update) && update.destination === SESSION_PERMISSION_DESTINATION;
}

export function filterSessionPermissionUpdates(
  updates?: readonly unknown[] | null,
): SessionPermissionUpdate[] {
  if (!Array.isArray(updates)) return [];
  return updates.filter(isSessionPermissionUpdate);
}

export function hasSessionPermissionUpdates(
  decision: { permissionUpdates?: readonly unknown[] | null },
): boolean {
  return filterSessionPermissionUpdates(decision.permissionUpdates).length > 0;
}
