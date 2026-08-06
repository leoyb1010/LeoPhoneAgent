import { beforeEach, describe, expect, it, vi } from 'vitest';

const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('@/i18n', () => ({
  i18n: {
    t: vi.fn((key: string, options?: { provider?: string; message?: string }) =>
      key === 'providerError.upstreamToast'
        ? `${options?.provider}: ${options?.message}`
        : key,
    ),
  },
}));

vi.mock('./toast', () => ({ toast: toastMocks }));

import { handleProviderUpstreamError } from './providerUpstreamErrorToast';

describe('handleProviderUpstreamError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the configured provider display name instead of the internal id', async () => {
    handleProviderUpstreamError({
      agent: 'claude-code',
      providerId: 'provider-abc',
      providerName: '测试网关',
      code: 'AUTH_INVALID',
      retryable: false,
      status: 401,
    });

    expect(toastMocks.error).toHaveBeenCalledWith('测试网关: providerError.AUTH_INVALID');
    expect(toastMocks.error.mock.calls[0]?.[0]).not.toContain('provider-abc');
  });
});
