import { describe, expect, it, vi } from 'vitest';

import { openTerminalFromShortcut } from '../openTerminalShortcut';

function makeOptions(results: Array<'attached' | 'routed' | 'queued' | 'stale-context'>) {
  const controller = new AbortController();
  const routeCommand = vi.fn(async () => results.shift() ?? 'stale-context');
  const openAttachedTerminal = vi.fn(async () => undefined);
  const waitForRetry = vi.fn(async () => true);
  return {
    controller,
    routeCommand,
    openAttachedTerminal,
    waitForRetry,
    options: {
      signal: controller.signal,
      isCurrentSession: () => true,
      routeCommand,
      openAttachedTerminal,
      waitForRetry,
    },
  };
}

describe('openTerminalFromShortcut', () => {
  it('stale-context 后重试到 routed，成功后不再重复派发', async () => {
    const h = makeOptions(['stale-context', 'stale-context', 'routed', 'attached']);

    await expect(openTerminalFromShortcut(h.options)).resolves.toBe('handled');

    expect(h.routeCommand).toHaveBeenCalledTimes(3);
    expect(h.waitForRetry).toHaveBeenCalledTimes(2);
    expect(h.openAttachedTerminal).not.toHaveBeenCalled();
  });

  it('stale-context 达到硬上限后停止', async () => {
    const h = makeOptions([]);

    await expect(
      openTerminalFromShortcut({ ...h.options, maxAttempts: 3 }),
    ).resolves.toBe('exhausted');

    expect(h.routeCommand).toHaveBeenCalledTimes(3);
    expect(h.waitForRetry).toHaveBeenCalledTimes(2);
    expect(h.openAttachedTerminal).not.toHaveBeenCalled();
  });

  it('attached 只执行一次本地 terminal 动作', async () => {
    const h = makeOptions(['stale-context', 'attached', 'attached']);

    await expect(openTerminalFromShortcut(h.options)).resolves.toBe('handled');

    expect(h.routeCommand).toHaveBeenCalledTimes(2);
    expect(h.openAttachedTerminal).toHaveBeenCalledTimes(1);
  });

  it.each(['routed', 'queued'] as const)('%s 是终态，不重试也不写本地 store', async (result) => {
    const h = makeOptions([result, 'attached']);

    await expect(openTerminalFromShortcut(h.options)).resolves.toBe('handled');

    expect(h.routeCommand).toHaveBeenCalledTimes(1);
    expect(h.waitForRetry).not.toHaveBeenCalled();
    expect(h.openAttachedTerminal).not.toHaveBeenCalled();
  });

  it('等待期间会话变化后取消，不再派发下一次命令', async () => {
    let current = true;
    const h = makeOptions(['stale-context', 'attached']);
    h.waitForRetry.mockImplementation(async () => {
      current = false;
      return true;
    });

    await expect(
      openTerminalFromShortcut({ ...h.options, isCurrentSession: () => current }),
    ).resolves.toBe('cancelled');

    expect(h.routeCommand).toHaveBeenCalledTimes(1);
    expect(h.openAttachedTerminal).not.toHaveBeenCalled();
  });

  it('组件卸载 abort 后取消等待', async () => {
    const h = makeOptions(['stale-context', 'attached']);
    h.waitForRetry.mockImplementation(async () => {
      h.controller.abort();
      return false;
    });

    await expect(openTerminalFromShortcut(h.options)).resolves.toBe('cancelled');

    expect(h.routeCommand).toHaveBeenCalledTimes(1);
    expect(h.openAttachedTerminal).not.toHaveBeenCalled();
  });
});
