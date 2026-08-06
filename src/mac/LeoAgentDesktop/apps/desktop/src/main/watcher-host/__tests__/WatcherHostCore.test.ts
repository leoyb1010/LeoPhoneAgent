/**
 * WatcherHostCore.test.ts — watcher utility process 核心簿记的单测。
 * 假 parcel 注入,覆盖:订阅/退订幂等、win32 backend 选择、事件与错误转发、
 * subscribe 失败的 ok:false 响应。
 */
import { describe, expect, it, vi } from 'vitest';

import { WatcherHostCore, type ParcelLike, type SubscriptionLike } from '../WatcherHostCore';
import type { WatchedFsEvent, WatcherHostMessage } from '../protocol';

type ParcelCb = (err: Error | null, events: WatchedFsEvent[]) => void;

function setup(platform: NodeJS.Platform = 'win32') {
  const posted: WatcherHostMessage[] = [];
  const subscribed: Array<{ dir: string; opts: { ignore: string[]; backend?: string }; cb: ParcelCb }> = [];
  const unsubscribe = vi.fn(async () => undefined);
  const parcel: ParcelLike = {
    subscribe: async (dir, cb, opts) => {
      subscribed.push({ dir, opts, cb });
      return { unsubscribe } satisfies SubscriptionLike;
    },
  };
  const core = new WatcherHostCore({
    loadParcel: () => parcel,
    post: (msg) => posted.push(msg),
    platform,
  });
  return { core, posted, subscribed, unsubscribe };
}

describe('WatcherHostCore', () => {
  it('subscribe:win32 显式 backend,响应 ok,事件按 subId 推回', async () => {
    const { core, posted, subscribed } = setup('win32');
    await core.handleRequest({ id: 1, op: 'subscribe', subId: 7, dir: 'D:/repo', ignore: ['D:/repo/.git'] });
    expect(posted).toContainEqual({ kind: 'response', id: 1, ok: true });
    expect(subscribed).toHaveLength(1);
    expect(subscribed[0].opts).toEqual({ ignore: ['D:/repo/.git'], backend: 'windows' });

    subscribed[0].cb(null, [{ type: 'create', path: 'D:/repo/a.txt' }]);
    expect(posted).toContainEqual({
      kind: 'push',
      event: 'fs-events',
      subId: 7,
      events: [{ type: 'create', path: 'D:/repo/a.txt' }],
    });
  });

  it('subscribe:非 win32 不指定 backend(让 parcel 自选原生后端)', async () => {
    const { core, subscribed } = setup('darwin');
    await core.handleRequest({ id: 1, op: 'subscribe', subId: 1, dir: '/repo', ignore: [] });
    expect(subscribed[0].opts).toEqual({ ignore: [] });
  });

  it('watcher 回调错误 → watch-error 推送,不炸进程', async () => {
    const { core, posted, subscribed } = setup();
    await core.handleRequest({ id: 1, op: 'subscribe', subId: 3, dir: 'D:/x', ignore: [] });
    subscribed[0].cb(new Error('boom'), []);
    expect(posted).toContainEqual({ kind: 'push', event: 'watch-error', subId: 3, message: 'boom' });
  });

  it('unsubscribe:拆真订阅且幂等;未知 subId 也回 ok', async () => {
    const { core, posted, unsubscribe } = setup();
    await core.handleRequest({ id: 1, op: 'subscribe', subId: 5, dir: 'D:/x', ignore: [] });
    await core.handleRequest({ id: 2, op: 'unsubscribe', subId: 5 });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(core.size).toBe(0);
    await core.handleRequest({ id: 3, op: 'unsubscribe', subId: 5 });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(posted).toContainEqual({ kind: 'response', id: 3, ok: true });
  });

  it('重复 subscribe 同 subId 幂等(不二次订阅)', async () => {
    const { core, subscribed } = setup();
    await core.handleRequest({ id: 1, op: 'subscribe', subId: 9, dir: 'D:/x', ignore: [] });
    await core.handleRequest({ id: 2, op: 'subscribe', subId: 9, dir: 'D:/x', ignore: [] });
    expect(subscribed).toHaveLength(1);
  });

  it('subscribe 失败 → ok:false 携带错误信息', async () => {
    const posted: WatcherHostMessage[] = [];
    const core = new WatcherHostCore({
      loadParcel: () => ({
        subscribe: async () => {
          throw new Error('dir gone');
        },
      }),
      post: (msg) => posted.push(msg),
      platform: 'win32',
    });
    await core.handleRequest({ id: 4, op: 'subscribe', subId: 1, dir: 'D:/gone', ignore: [] });
    expect(posted).toContainEqual({ kind: 'response', id: 4, ok: false, error: 'dir gone' });
    expect(core.size).toBe(0);
  });
});
