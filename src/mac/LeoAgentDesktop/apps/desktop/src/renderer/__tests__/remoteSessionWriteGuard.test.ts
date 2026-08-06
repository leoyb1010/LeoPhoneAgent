import { describe, expect, it } from 'vitest';

import {
  isDeviceLinkWriteBlocked,
  isRemoteSessionWriteBlocked,
} from '@/features/cc-agent/lib/remoteSessionWriteGuard';

describe('remote session write guard', () => {
  it('blocks writes only for disconnected cached device-link sessions', () => {
    expect(
      isRemoteSessionWriteBlocked({
        deviceLinkDeviceId: 'device-1',
        deviceLinkConnectionStatus: 'disconnected',
      }),
    ).toBe(true);

    expect(
      isRemoteSessionWriteBlocked({
        deviceLinkDeviceId: 'device-1',
        deviceLinkConnectionStatus: 'connected',
      }),
    ).toBe(false);
    expect(
      isRemoteSessionWriteBlocked({
        deviceLinkDeviceId: undefined,
        deviceLinkConnectionStatus: 'disconnected',
      }),
    ).toBe(false);
  });

  it('uses the same write block for disconnected device-link projects', () => {
    expect(
      isDeviceLinkWriteBlocked({
        deviceLinkDeviceId: 'device-1',
        deviceLinkConnectionStatus: 'disconnected',
      }),
    ).toBe(true);
    expect(
      isDeviceLinkWriteBlocked({
        deviceLinkDeviceId: 'device-1',
        deviceLinkConnectionStatus: 'connected',
      }),
    ).toBe(false);
  });
});
