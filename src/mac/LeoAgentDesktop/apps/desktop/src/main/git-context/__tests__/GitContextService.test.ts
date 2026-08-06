/**
 * GitContextService.test.ts — HEAD watcher 的 refcount + unwatch 宽限期回归。
 *
 * 与 file-browser watcher 同一崩溃背景:切 session 时 per-session 徽标组件
 * 先卸载再挂载,同一 gitdir 毫秒级 unwatch→watch。锁死宽限期语义:
 * 宽限内 re-watch 零 native 操作;宽限过后才真正 unsubscribe。
 */
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const h = vi.hoisted(() => ({
  gitDir: '',
  headPath: '',
}));

vi.mock('../headReader', () => ({
  resolveHeadLocation: vi.fn(async () => ({ gitDir: h.gitDir, headPath: h.headPath })),
  readGitHead: vi.fn(async () => ({ kind: 'branch', branch: 'main', shortSha: 'abc1234' })),
}));

import { GitContextService } from '../GitContextService';

function setup() {
  h.gitDir = path.resolve('/repo/.git');
  h.headPath = path.resolve('/repo/.git/HEAD');
  const unsubscribe = vi.fn(async () => undefined);
  const subscribeFn = vi.fn(async () => ({ unsubscribe }));
  const onChanged = vi.fn();
  const service = new GitContextService({ onChanged, subscribeFn });
  return { service, subscribeFn, unsubscribe, onChanged };
}

describe('GitContextService unwatch 宽限期', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('watch:向 host 订阅 gitDir 并带 ignore 预剪列表', async () => {
    const { service, subscribeFn } = setup();
    await service.watch('/repo');
    expect(subscribeFn).toHaveBeenCalledTimes(1);
    const [dir, ignore] = (subscribeFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string[]];
    expect(dir).toBe(h.gitDir);
    expect(ignore).toContain(path.join(h.gitDir, 'objects'));
  });

  it('unwatch→宽限内 re-watch:零 native 操作(切 session 抖动回归)', async () => {
    const { service, subscribeFn, unsubscribe } = setup();
    await service.watch('/repo');
    await service.unwatch('/repo');
    await vi.advanceTimersByTimeAsync(10);
    await service.watch('/repo'); // 宽限内复活
    await vi.advanceTimersByTimeAsync(60_000);
    expect(subscribeFn).toHaveBeenCalledTimes(1);
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it('unwatch 宽限过后真正 unsubscribe', async () => {
    const { service, unsubscribe } = setup();
    await service.watch('/repo');
    await service.unwatch('/repo');
    await vi.advanceTimersByTimeAsync(2_000); // > UNWATCH_GRACE_MS(1500)
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('refcount:多 watcher 叠加时中途 unwatch 不拆订阅', async () => {
    const { service, unsubscribe } = setup();
    await service.watch('/repo');
    await service.watch('/repo');
    await service.unwatch('/repo');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(unsubscribe).not.toHaveBeenCalled();
    await service.unwatch('/repo');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('dispose 无视宽限期立即清理', async () => {
    const { service, unsubscribe } = setup();
    await service.watch('/repo');
    await service.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
