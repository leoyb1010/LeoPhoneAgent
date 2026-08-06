import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MOBILE_VOICE_LITELLM_BASE_URL } from '@/config/env';
import type { MobileVoiceCredentialSyncResult } from '@cindy/maker-shared/device-link-contract';

const secureItems = vi.hoisted(() => new Map<string, string>());

vi.mock('@/auth/secureStorage', () => ({
  getSecureItem: vi.fn(async (key: string) => secureItems.get(key) ?? null),
  setSecureItem: vi.fn(async (key: string, value: string) => {
    secureItems.set(key, value);
  }),
  deleteSecureItem: vi.fn(async (key: string) => {
    secureItems.delete(key);
  }),
}));

function credential(overrides: Partial<MobileVoiceCredentialSyncResult> = {}): MobileVoiceCredentialSyncResult {
  return {
    temporary: true,
    credentialVersion: 1,
    issuedAt: '2026-06-19T00:00:00.000Z',
    proxyBaseUrl: DEFAULT_MOBILE_VOICE_LITELLM_BASE_URL,
    proxyApiKey: 'sk-xd-gateway-secret',
    asr: {
      provider: 'litellm-volcengine-sauc-asr',
      model: 'volcengine-sauc-asr',
      auth: 'api-key',
      mode: 'provider-native-websocket',
      endpointPath: '/volcengine/api/v3/sauc/bigmodel_async',
      pcmSampleRate: 16000,
      protocolProfile: 'volcengine-sauc-duration',
      resourceId: 'volc.seedasr.sauc.duration',
    },
    refiner: {
      provider: 'litellm-gpt-5.4-mini',
      model: 'gpt-5.4-mini',
      auth: 'api-key',
      transport: 'litellm-chat-completions',
      endpointPath: '/v1/chat/completions',
    },
    ...overrides,
  };
}

describe('mobileVoiceCredentialStore', () => {
  beforeEach(() => {
    secureItems.clear();
  });

  it('clears legacy per-host credentials, the host index, service mode and BYOK key storage', async () => {
    const { __testing, clearAllMobileVoiceCredentials } = await import('@/session/mobileVoiceCredentialStore');

    // 旧版本可能留下:逐 host 凭据(带索引)、服务模式开关、BYOK LiteLLM key。
    secureItems.set(__testing.storageKeyForHostDevice('host-a'), '{"proxyApiKey":"sk-host-a"}');
    secureItems.set(__testing.storageKeyForHostDevice('host-b'), '{"proxyApiKey":"sk-host-b"}');
    secureItems.set(__testing.storageIndexKey, JSON.stringify(['host-a', 'host-b']));
    secureItems.set(__testing.legacyServiceModeStorageKey, 'byok');
    secureItems.set(
      __testing.legacyLiteLlmSettingsStorageKey,
      JSON.stringify({ proxyApiKey: 'sk-user-own-key', storageVersion: 1 }),
    );

    await clearAllMobileVoiceCredentials();

    expect(secureItems.has(__testing.storageKeyForHostDevice('host-a'))).toBe(false);
    expect(secureItems.has(__testing.storageKeyForHostDevice('host-b'))).toBe(false);
    expect(secureItems.has(__testing.storageIndexKey)).toBe(false);
    expect(secureItems.has(__testing.legacyServiceModeStorageKey)).toBe(false);
    expect(secureItems.has(__testing.legacyLiteLlmSettingsStorageKey)).toBe(false);
  });

  it('clears legacy mode/key storage even when no per-host index exists', async () => {
    const { __testing, clearAllMobileVoiceCredentials } = await import('@/session/mobileVoiceCredentialStore');

    secureItems.set(__testing.legacyServiceModeStorageKey, 'byok');
    secureItems.set(__testing.legacyLiteLlmSettingsStorageKey, '{"proxyApiKey":"sk-user-own-key"}');

    await clearAllMobileVoiceCredentials();

    expect(secureItems.size).toBe(0);
  });

  it('ignores a malformed host index during cleanup', async () => {
    const { __testing, clearAllMobileVoiceCredentials } = await import('@/session/mobileVoiceCredentialStore');

    secureItems.set(__testing.storageIndexKey, 'not-json');
    secureItems.set(__testing.legacyServiceModeStorageKey, 'byok');

    await clearAllMobileVoiceCredentials();

    expect(secureItems.has(__testing.storageIndexKey)).toBe(false);
    expect(secureItems.has(__testing.legacyServiceModeStorageKey)).toBe(false);
  });

  it('redacts proxyApiKey for diagnostics without mutating the credential', async () => {
    const { redactMobileVoiceCredentialForLog } = await import('@/session/mobileVoiceCredentialStore');

    const source = {
      ...credential(),
      hostDeviceId: 'host-a',
      storageVersion: 1 as const,
      syncedAt: '2026-06-19T00:01:00.000Z',
    };
    const redacted = redactMobileVoiceCredentialForLog(source);

    expect(redacted.proxyApiKey).toBe('[REDACTED]');
    expect(source.proxyApiKey).toBe('sk-xd-gateway-secret');
    expect(redacted.asr).toEqual(source.asr);
  });

  it('validates the provider graph shape and rejects malformed credentials', async () => {
    const { assertMobileVoiceCredentialShape } = await import('@/session/mobileVoiceCredentialStore');

    expect(() => assertMobileVoiceCredentialShape(credential())).not.toThrow();
    // 托管图:refiner 用 'auto' 标记也应通过(服务端覆盖 provider/model)。
    expect(() => assertMobileVoiceCredentialShape(credential({
      refiner: {
        provider: 'auto',
        model: 'auto',
        auth: 'api-key',
        transport: 'litellm-chat-completions',
        endpointPath: '/v1/chat/completions',
      },
    }))).not.toThrow();
    expect(() => assertMobileVoiceCredentialShape(credential({ proxyBaseUrl: '' }))).toThrow(
      'voice credential missing proxyBaseUrl',
    );
    expect(() => assertMobileVoiceCredentialShape(credential({
      refiner: {
        provider: 'litellm-gpt-5.4-mini',
        model: 'gpt-5.4-mini',
        auth: 'api-key',
        transport: 'unsupported-transport' as never,
      },
    }))).toThrow('voice credential refiner transport is unsupported');
    expect(() => assertMobileVoiceCredentialShape(credential({
      asr: { ...credential().asr, auth: 'oauth' as never },
    }))).toThrow('voice credential ASR auth must be api-key or codex');
  });
});
