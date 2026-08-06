import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveVoiceInputStartGuards } from '../startGuards';

const grantedPermission = { ok: true as const, status: 'granted' };
const ready = {
  ok: true,
  provider: 'litellm',
  providerModel: 'test-model',
  auth: 'api-key' as const,
  settingsTab: 'api-keys' as const,
};

function stubVoiceInputApis(platform: 'darwin' | 'win32') {
  const getUserMedia = vi.fn();
  const setRendererMicrophonePermissionVerified = vi.fn(async () => ({ ok: true as const }));
  const requestMicrophonePermission = vi.fn();
  const getSystemPermissions = vi.fn();

  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('window', {
    electronAPI: {
      platform,
      voiceInput: {
        getMicrophonePermissionCached: vi.fn(() => grantedPermission),
        getSystemPermissionsCached: vi.fn(() => ({
          microphone: grantedPermission,
          inputMonitoring: grantedPermission,
          accessibility: grantedPermission,
        })),
        getReadinessCached: vi.fn(() => ready),
        getReadiness: vi.fn(async () => ready),
        getSystemPermissions,
        requestMicrophonePermission,
        setRendererMicrophonePermissionVerified,
      },
    },
  });

  return {
    getUserMedia,
    getSystemPermissions,
    requestMicrophonePermission,
    setRendererMicrophonePermissionVerified,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('resolveVoiceInputStartGuards', () => {
  it('revalidates a positive Windows cache before allowing voice input to start', async () => {
    const apis = stubVoiceInputApis('win32');
    const denial = {
      ok: false as const,
      status: 'denied',
      error: 'Microphone permission is required for voice input. Enable it in Windows Settings.',
    };
    apis.getUserMedia.mockRejectedValue(new Error('Permission denied'));
    apis.requestMicrophonePermission.mockResolvedValue(denial);
    apis.getSystemPermissions.mockResolvedValue({
      microphone: denial,
      inputMonitoring: grantedPermission,
      accessibility: grantedPermission,
    });

    const result = await resolveVoiceInputStartGuards();

    expect(result).toMatchObject({
      ok: false,
      failed: 'permission',
      permission: denial,
      permissionSource: 'async',
    });
    expect(apis.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(apis.setRendererMicrophonePermissionVerified).toHaveBeenCalledWith(false);
  });

  it('allows Windows voice input after renderer permission is granted', async () => {
    const apis = stubVoiceInputApis('win32');
    const stop = vi.fn();
    apis.getUserMedia.mockResolvedValue({ getTracks: () => [{ stop }] });
    apis.getSystemPermissions.mockResolvedValue({
      microphone: grantedPermission,
      inputMonitoring: grantedPermission,
      accessibility: grantedPermission,
    });

    const result = await resolveVoiceInputStartGuards();

    expect(result).toMatchObject({
      ok: true,
      permission: grantedPermission,
      permissionSource: 'async',
    });
    expect(stop).toHaveBeenCalledOnce();
    expect(apis.setRendererMicrophonePermissionVerified).toHaveBeenCalledWith(true);
  });

  it('keeps trusting a positive macOS cache on the start path', async () => {
    const apis = stubVoiceInputApis('darwin');

    const result = await resolveVoiceInputStartGuards();

    expect(result).toMatchObject({
      ok: true,
      permission: grantedPermission,
      permissionSource: 'cache',
    });
    expect(apis.getUserMedia).not.toHaveBeenCalled();
  });
});
