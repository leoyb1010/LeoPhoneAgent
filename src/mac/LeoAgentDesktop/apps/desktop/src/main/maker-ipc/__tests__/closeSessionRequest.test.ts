import { describe, it, expect, vi } from 'vitest';

import {
  handleCloseSessionRequest,
  parseCloseSessionOptions,
  type CloseSessionRequestDeps,
} from '../closeSessionRequest';

function makeDeps() {
  const order: string[] = [];
  const deps: CloseSessionRequestDeps = {
    closeSession: vi.fn(async () => {
      order.push('close');
    }),
    withRehydrateCloseSuppressed: vi.fn(async (_sessionId, fn) => {
      order.push('suppress-enter');
      const result = await fn();
      order.push('suppress-exit');
      return result;
    }),
    cleanupPendingInteractions: vi.fn(() => {
      order.push('cleanup-interactions');
    }),
  };
  return { deps, order };
}

describe('parseCloseSessionOptions', () => {
  it('only accepts preserveWorkspace === true', () => {
    expect(parseCloseSessionOptions({ preserveWorkspace: true })).toEqual({ preserveWorkspace: true });
    // IPC 边界形状不可信:truthy 非 true 一律不算
    expect(parseCloseSessionOptions({ preserveWorkspace: 1 }).preserveWorkspace).toBe(false);
    expect(parseCloseSessionOptions({ preserveWorkspace: 'true' }).preserveWorkspace).toBe(false);
    expect(parseCloseSessionOptions(undefined).preserveWorkspace).toBeUndefined();
    expect(parseCloseSessionOptions(null).preserveWorkspace).toBeUndefined();
    expect(parseCloseSessionOptions('junk').preserveWorkspace).toBeUndefined();
  });
});

describe('handleCloseSessionRequest', () => {
  it('plain close: no suppression, cleanup runs after close', async () => {
    const { deps, order } = makeDeps();

    await handleCloseSessionRequest(deps, 's1', undefined);

    expect(deps.closeSession).toHaveBeenCalledWith('s1');
    expect(deps.withRehydrateCloseSuppressed).not.toHaveBeenCalled();
    expect(order).toEqual(['close', 'cleanup-interactions']);
  });

  it('preserveWorkspace: close runs inside the suppression window', async () => {
    const { deps, order } = makeDeps();

    await handleCloseSessionRequest(deps, 's1', { preserveWorkspace: true });

    expect(deps.withRehydrateCloseSuppressed).toHaveBeenCalledWith('s1', expect.any(Function));
    // close 必须发生在抑制窗口内,否则 onClose 副作用照跑
    expect(order).toEqual(['suppress-enter', 'close', 'suppress-exit', 'cleanup-interactions']);
  });

  it('malformed opts fall back to plain close', async () => {
    const { deps } = makeDeps();

    await handleCloseSessionRequest(deps, 's1', { preserveWorkspace: 'yes' });

    expect(deps.withRehydrateCloseSuppressed).not.toHaveBeenCalled();
    expect(deps.closeSession).toHaveBeenCalledWith('s1');
  });

  it('close failure propagates and skips interaction cleanup', async () => {
    const { deps } = makeDeps();
    (deps.closeSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));

    await expect(handleCloseSessionRequest(deps, 's1', undefined)).rejects.toThrow('boom');
    expect(deps.cleanupPendingInteractions).not.toHaveBeenCalled();
  });
});
