import { describe, expect, it, vi } from 'vitest';

import {
  bearerAccessTokenFromHeaders,
  createChatgptBridgeAuthInvalidator,
  detectChatgptBridgeAuthInvalidationReason,
} from '../chatgpt-bridge-auth-invalidation.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('ChatGPT bridge auth invalidation', () => {
  it('只把认证状态码里的明确作废信号分类为重连原因', () => {
    expect(
      detectChatgptBridgeAuthInvalidationReason(401, '{"error":{"code":"token_invalidated"}}'),
    ).toBe('token_invalidated');
    expect(detectChatgptBridgeAuthInvalidationReason(403, 'token_revoked')).toBe('token_revoked');
    expect(
      detectChatgptBridgeAuthInvalidationReason(401, 'OAuth refresh token was already used'),
    ).toBe('refresh_token_reused');
    expect(detectChatgptBridgeAuthInvalidationReason(401, 'Unauthorized workspace')).toBeNull();
    expect(detectChatgptBridgeAuthInvalidationReason(429, 'token_invalidated')).toBeNull();
  });

  it('大小写无关地读取本次请求的 bearer token', () => {
    expect(bearerAccessTokenFromHeaders({ Authorization: 'Bearer failed-token' })).toBe(
      'failed-token',
    );
    expect(bearerAccessTokenFromHeaders({ authorization: 'Basic abc' })).toBeNull();
  });

  it('当前凭证仍是失败 token 时执行失效', async () => {
    const invalidate = vi.fn(async () => undefined);
    const handleFailure = createChatgptBridgeAuthInvalidator({
      getCurrentAccessToken: async () => 'failed-token',
      invalidate,
    });

    await expect(
      handleFailure({
        status: 401,
        body: '{"error":{"code":"token_invalidated"}}',
        failedAccessToken: 'failed-token',
      }),
    ).resolves.toBe(true);
    expect(invalidate).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledWith('token_invalidated');
  });

  it('忽略新登录后迟到的旧 token 失败', async () => {
    const invalidate = vi.fn(async () => undefined);
    const handleFailure = createChatgptBridgeAuthInvalidator({
      getCurrentAccessToken: async () => 'new-token',
      invalidate,
    });

    await expect(
      handleFailure({
        status: 401,
        body: 'token_revoked',
        failedAccessToken: 'old-token',
      }),
    ).resolves.toBe(false);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('合并同一失败 token 的并发失效', async () => {
    const currentToken = deferred<string | null>();
    const invalidate = vi.fn(async () => undefined);
    const getCurrentAccessToken = vi.fn(() => currentToken.promise);
    const handleFailure = createChatgptBridgeAuthInvalidator({
      getCurrentAccessToken,
      invalidate,
    });
    const failure = {
      status: 401,
      body: 'token_invalidated',
      failedAccessToken: 'failed-token',
    };

    const first = handleFailure(failure);
    const second = handleFailure(failure);
    currentToken.resolve('failed-token');

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(getCurrentAccessToken).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledOnce();
  });
});
