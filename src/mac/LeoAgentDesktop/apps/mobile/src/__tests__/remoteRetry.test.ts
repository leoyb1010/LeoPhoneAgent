import { describe, expect, it, vi } from 'vitest';
import { isTransientRemoteError, withTransientRemoteRetry } from '@/device-link/remoteRetry';

const noSleep = async () => {};

describe('remoteRetry', () => {
  it('classifies transient and permanent remote errors', () => {
    expect(isTransientRemoteError(new Error('DbClient not ready'))).toBe(true);
    expect(isTransientRemoteError(Object.assign(new Error('client is not ready'), { code: 'NOT_CONNECTED' }))).toBe(true);
    expect(isTransientRemoteError(Object.assign(new Error('target offline'), { code: 'DEVICE_OFFLINE' }))).toBe(true);
    expect(isTransientRemoteError('[DEVICE_LINK_TIMEOUT] no result')).toBe(true);
    expect(isTransientRemoteError(Object.assign(new Error('remote disabled'), { code: 'REMOTE_DISABLED' }))).toBe(false);
    expect(isTransientRemoteError("[CHANNEL_NOT_ALLOWED] channel 'x' not allowed")).toBe(false);
    expect(isTransientRemoteError(new Error('unexpected'))).toBe(false);
  });

  it('retries transient failures until success', async () => {
    const op = vi.fn()
      .mockRejectedValueOnce(new Error('DbClient not ready'))
      .mockRejectedValueOnce(Object.assign(new Error('not connected'), { code: 'NOT_CONNECTED' }))
      .mockResolvedValueOnce('ok');

    await expect(withTransientRemoteRetry(op, { sleep: noSleep })).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('does not retry permanent failures', async () => {
    const op = vi.fn().mockRejectedValue(new Error('[REMOTE_DISABLED] remote control disabled'));
    await expect(withTransientRemoteRetry(op, { sleep: noSleep })).rejects.toThrow('remote control disabled');
    expect(op).toHaveBeenCalledTimes(1);
  });
});
