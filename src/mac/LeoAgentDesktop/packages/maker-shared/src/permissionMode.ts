/** 所有客户端共同识别的权限档位；未知值必须按最安全的 ask 处理。 */
export type SharedPermissionMode =
  | 'ask'
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'auto'
  | 'bypassPermissions';

const PERMISSION_MODES = new Set<SharedPermissionMode>([
  'ask',
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'bypassPermissions',
]);

/**
 * 将持久化或远端传来的权限值收敛为已知档位。
 * 缺失、空串和未来新增但当前客户端不认识的值都 fail-closed 到 ask。
 */
export function permissionModeOrAsk(value: unknown): SharedPermissionMode {
  return typeof value === 'string' && PERMISSION_MODES.has(value as SharedPermissionMode)
    ? value as SharedPermissionMode
    : 'ask';
}

/** 从任意非 Full access 档位进入 Full access 时都必须显式确认。 */
export function requiresFullAccessConfirmation(
  currentMode: unknown,
  nextMode: unknown,
): boolean {
  return permissionModeOrAsk(nextMode) === 'bypassPermissions'
    && permissionModeOrAsk(currentMode) !== 'bypassPermissions';
}
