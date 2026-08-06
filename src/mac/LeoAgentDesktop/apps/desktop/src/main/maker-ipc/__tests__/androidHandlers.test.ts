import { describe, expect, it, vi } from 'vitest';

import { MAKER_INVOKE } from '../channels';
import {
  normalizeAndroidStatusResult,
  registerAndroidAutomationHandlers,
} from '../androidHandlers';
import { IpcHarness } from './helpers/ipcHarness';

describe('android automation IPC handlers', () => {
  it('returns adb status through the injected backend summary', async () => {
    const harness = new IpcHarness();
    const status = {
      adb_available: true,
      adb_path: '/sdk/platform-tools/adb',
      version: 'Android Debug Bridge version 1.0.41',
      devices: [{ device_serial: 'emulator-5554', state: 'device' }],
      default_device_serial: 'emulator-5554',
      issue: null,
    };
    const getStatusSummary = vi.fn().mockResolvedValue({ ok: true, data: status });

    registerAndroidAutomationHandlers(harness, { getStatusSummary });

    await expect(harness.invoke(MAKER_INVOKE.ANDROID_STATUS)).resolves.toEqual(status);
    expect(getStatusSummary).toHaveBeenCalledOnce();
  });

  it('normalizes adb business errors into structured Settings status', () => {
    expect(
      normalizeAndroidStatusResult({
        ok: false,
        errorCode: 'ADB_NOT_FOUND',
        message: 'spawn adb ENOENT',
      }),
    ).toEqual({
      adb_available: false,
      adb_path: null,
      adb_path_source: null,
      version: null,
      devices: [],
      default_device_serial: null,
      configured_default_device_serial: null,
      issue: 'ADB_NOT_FOUND',
      error: 'spawn adb ENOENT',
    });
  });

  it('includes Android status metadata from structured backend failures', () => {
    expect(
      normalizeAndroidStatusResult({
        ok: false,
        errorCode: 'ADB_NOT_FOUND',
        message: 'spawn adb ENOENT',
        data: {
          adb_path_source: 'custom',
          configured_default_device_serial: 'phone-a',
          adb_preparation: {
            supported: true,
            ready: false,
            platform: 'win32-x64',
            path: null,
            source: 'custom',
            error: 'spawn adb ENOENT',
          },
        },
      }),
    ).toMatchObject({
      adb_available: false,
      adb_path_source: 'custom',
      configured_default_device_serial: 'phone-a',
      adb_preparation: {
        supported: true,
        ready: false,
        source: 'custom',
      },
      issue: 'ADB_NOT_FOUND',
    });
  });

  it('reads and updates Android automation config through injected storage', async () => {
    const harness = new IpcHarness();
    let value = { defaultDeviceSerial: null as string | null, adbPathOverride: null as string | null };
    const getSettingsState = vi.fn(() => ({
      value,
      defaults: { defaultDeviceSerial: null, adbPathOverride: null },
      isCustomized: Boolean(value.defaultDeviceSerial || value.adbPathOverride),
      customizedKeys: Object.entries(value)
        .filter(([, item]) => item !== null)
        .map(([key]) => key),
    }));
    const setDefaultDeviceSerial = vi.fn((serial: string | null) => {
      value = { ...value, defaultDeviceSerial: serial };
      return value;
    });
    const setAdbPathOverride = vi.fn((adbPath: string | null) => {
      value = { ...value, adbPathOverride: adbPath };
      return value;
    });

    registerAndroidAutomationHandlers(harness, {
      getSettingsState,
      setDefaultDeviceSerial,
      setAdbPathOverride,
    });

    await expect(harness.invoke(MAKER_INVOKE.ANDROID_GET_CONFIG)).resolves.toMatchObject({
      value: { defaultDeviceSerial: null, adbPathOverride: null },
    });
    await expect(harness.invoke(MAKER_INVOKE.ANDROID_SET_DEFAULT_DEVICE, {
      defaultDeviceSerial: ' phone-a ',
    })).resolves.toMatchObject({
      value: { defaultDeviceSerial: 'phone-a', adbPathOverride: null },
      customizedKeys: ['defaultDeviceSerial'],
    });
    await expect(harness.invoke(MAKER_INVOKE.ANDROID_SET_ADB_PATH, {
      adbPathOverride: ' /custom/adb ',
    })).resolves.toMatchObject({
      value: { defaultDeviceSerial: 'phone-a', adbPathOverride: '/custom/adb' },
      customizedKeys: ['defaultDeviceSerial', 'adbPathOverride'],
    });
    expect(setDefaultDeviceSerial).toHaveBeenCalledWith('phone-a');
    expect(setAdbPathOverride).toHaveBeenCalledWith('/custom/adb');
  });

  it('rejects invalid Android config payloads with INVALID_PARAMS', async () => {
    const harness = new IpcHarness();
    registerAndroidAutomationHandlers(harness);

    await expect(harness.invoke(MAKER_INVOKE.ANDROID_SET_DEFAULT_DEVICE, {
      defaultDeviceSerial: 123,
    })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
  });

  it('exposes the adb preparation handler', async () => {
    const harness = new IpcHarness();
    const prepareAdb = vi.fn().mockResolvedValue({
      supported: true,
      ready: true,
      platform: 'win32-x64',
      path: '/adb.exe',
      source: 'bundled',
    });
    registerAndroidAutomationHandlers(harness, { prepareAdb });

    await expect(harness.invoke(MAKER_INVOKE.ANDROID_PREPARE_ADB)).resolves.toEqual({
      supported: true,
      ready: true,
      platform: 'win32-x64',
      path: '/adb.exe',
      source: 'bundled',
    });
  });

  it('uses throwIpcError for unexpected handler failures', async () => {
    const harness = new IpcHarness();
    registerAndroidAutomationHandlers(harness, {
      getStatusSummary: vi.fn().mockRejectedValue(new Error('backend crashed')),
    });

    await expect(harness.invoke(MAKER_INVOKE.ANDROID_STATUS)).rejects.toMatchObject({
      code: 'INTERNAL',
    });
  });
});
