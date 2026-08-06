import type { DeviceLinkConnectionStatus, Session } from '@/lib/ccAgent.types';

interface DeviceLinkWriteState {
  deviceLinkDeviceId?: string | null;
  deviceLinkConnectionStatus?: DeviceLinkConnectionStatus | null;
}

/** Device-link entities stay selectable while cached offline, but writes must wait for reconnection. */
export function isDeviceLinkWriteBlocked(
  target: DeviceLinkWriteState | null | undefined,
): boolean {
  return Boolean(
    target?.deviceLinkDeviceId &&
      target.deviceLinkConnectionStatus === 'disconnected',
  );
}

/** Device-link sessions stay selectable while cached offline, but writes must wait for reconnection. */
export function isRemoteSessionWriteBlocked(
  session: Pick<Session, 'deviceLinkDeviceId' | 'deviceLinkConnectionStatus'> | null | undefined,
): boolean {
  return isDeviceLinkWriteBlocked(session);
}
