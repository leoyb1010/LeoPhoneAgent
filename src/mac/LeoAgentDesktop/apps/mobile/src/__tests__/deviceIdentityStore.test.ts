import { describe, expect, it, vi } from 'vitest';
import type { DeviceView } from '@cindy/device-link';
import {
  createEmptyDeviceIdentityCache,
  hydrateDeviceIdentityCache,
  normalizeDeviceDisplayName,
  reconcileDeviceIdentities,
} from '@/device-link/deviceIdentityStore';

vi.mock('@/auth/secureStorage', () => ({
  getSecureItem: vi.fn(async () => null),
  setSecureItem: vi.fn(async () => undefined),
}));

function device(patch: Partial<DeviceView> = {}): DeviceView {
  return {
    deviceId: 'dev-1',
    name: 'Mac',
    platform: 'darwin',
    appVersion: '0.0.0-test',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
    online: true,
    busy: false,
    remoteControlEnabled: true,
    isSelf: false,
    ...patch,
  };
}

describe('mobile device identity cache', () => {
  it('keeps only real device display names', () => {
    expect(normalizeDeviceDisplayName(' CarolFlow16 ')).toBe('CarolFlow16');
    expect(normalizeDeviceDisplayName('unknown')).toBeNull();
    expect(normalizeDeviceDisplayName('no')).toBeNull();
    expect(normalizeDeviceDisplayName('')).toBeNull();
  });

  it('reuses the last known name when the server returns a placeholder name', () => {
    const cache = createEmptyDeviceIdentityCache();
    const first = reconcileDeviceIdentities([
      device({ deviceId: 'pc', name: 'PC' }),
    ], cache);
    const second = reconcileDeviceIdentities([
      device({ deviceId: 'pc', name: 'unknown', online: false }),
    ], first.cache);

    expect(second.devices[0]).toMatchObject({
      deviceId: 'pc',
      name: 'PC',
      online: false,
    });
    expect(second.viewsChanged).toBe(true);
  });

  it('keeps first-seen order stable while moving offline devices to the right', () => {
    const first = reconcileDeviceIdentities([
      device({ deviceId: 'mac', name: 'Mac', online: true }),
      device({ deviceId: 'pc', name: 'PC', online: true }),
    ], createEmptyDeviceIdentityCache());
    const second = reconcileDeviceIdentities([
      device({ deviceId: 'pc', name: 'PC', online: true, lastSeenAt: '2026-01-01T00:03:00.000Z' }),
      device({ deviceId: 'mac', name: 'Mac', online: true, lastSeenAt: '2026-01-01T00:04:00.000Z' }),
    ], first.cache);
    const third = reconcileDeviceIdentities([
      device({ deviceId: 'pc', name: 'PC', online: true }),
      device({ deviceId: 'mac', name: 'Mac', online: false }),
    ], second.cache);

    expect(second.devices.map((item) => item.deviceId)).toEqual(['mac', 'pc']);
    expect(third.devices.map((item) => item.deviceId)).toEqual(['pc', 'mac']);
  });

  it('normalizes stored cache before use', () => {
    const cache = hydrateDeviceIdentityCache({
      names: { ok: ' Mac ', placeholder: 'unknown' },
      nextOrder: -10,
      order: { ok: 2, bad: Number.NaN },
    });

    expect(cache).toEqual({
      names: { ok: 'Mac' },
      nextOrder: 3,
      order: { ok: 2 },
    });
  });
});
