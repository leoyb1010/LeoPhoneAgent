/**
 * WatcherHostClient.test.ts — main 侧 watcher host 代理的单测。
 * 假 fork 注入,覆盖:RPC 配对与事件路由、子进程崩溃后的退避重启 + 订阅重放、
 * 连续崩溃降级、unsubscribe 簿记。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WatcherHostClient, type WatcherHostChildLike } from '../WatcherHostClient';
import type { WatcherHostMessage, WatcherHostRequest } from '../protocol';

class FakeChild implements WatcherHostChildLike {
  sent: WatcherHostRequest[] = [];
  autoRespondOk = true;
  killed = false;
  private messageHandlers: Array<(msg: unknown) => void> = [];
  private exitHandlers: Array<(code: number) => void> = [];

  postMessage(msg: unknown): void {
    const req = msg as WatcherHostRequest;
    this.sent.push(req);
    if (this.autoRespondOk) {
      queueMicrotask(() => this.emit({ kind: 'response', id: req.id, ok: true }));
    }
  }

  on(event: 'message', cb: (msg: unknown) => void): void;
  on(event: 'exit', cb: (code: number) => void): void;
  on(event: string, cb: (arg: never) => void): void {
    if (event === 'message') this.messageHandlers.push(cb as (msg: unknown) => void);
    else if (event === 'exit') this.exitHandlers.push(cb as (code: number) => void);
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  emit(msg: WatcherHostMessage): void {
    for (const h of this.messageHandlers) h(msg);
  }

  emitExit(code: number): void {
    for (const h of this.exitHandlers) h(code);
  }
}

function makeLog() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('WatcherHostClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const children: FakeChild[] = [];
    const fork = vi.fn(() => {
      const c = new FakeChild();
      children.push(c);
      return c;
    });
    const log = makeLog();
    const client = new WatcherHostClient({ fork, log });
    return { client, children, fork, log };
  }

  it('subscribe 发 RPC 并把 fs-events 按 subId 路由到回调', async () => {
    const { client, children } = setup();
    const onEvents = vi.fn();
    await client.subscribe('D:/repo', ['D:/repo/.git'], onEvents);
    expect(children).toHaveLength(1);
    const sub = children[0].sent.find((m) => m.op === 'subscribe');
    expect(sub).toMatchObject({ op: 'subscribe', dir: 'D:/repo', ignore: ['D:/repo/.git'] });

    children[0].emit({
      kind: 'push',
      event: 'fs-events',
      subId: (sub as { subId: number }).subId,
      events: [{ type: 'update', path: 'D:/repo/a.txt' }],
    });
    expect(onEvents).toHaveBeenCalledWith([{ type: 'update', path: 'D:/repo/a.txt' }]);
  });

  it('子进程意外退出 → 退避后重启并重放订阅,事件在新子进程上继续路由', async () => {
    const { client, children, fork } = setup();
    const onEvents = vi.fn();
    await client.subscribe('D:/repo', [], onEvents);
    expect(fork).toHaveBeenCalledTimes(1);
    const firstSubId = (children[0].sent[0] as { subId: number }).subId;

    children[0].emitExit(1);
    // 首次崩溃退避 500ms
    await vi.advanceTimersByTimeAsync(600);
    expect(fork).toHaveBeenCalledTimes(2);
    const replay = children[1].sent.find((m) => m.op === 'subscribe');
    expect(replay).toMatchObject({ op: 'subscribe', dir: 'D:/repo', subId: firstSubId });

    children[1].emit({
      kind: 'push',
      event: 'fs-events',
      subId: firstSubId,
      events: [{ type: 'delete', path: 'D:/repo/b.txt' }],
    });
    expect(onEvents).toHaveBeenCalledWith([{ type: 'delete', path: 'D:/repo/b.txt' }]);
    expect(client.activeSubscriptionCount).toBe(1);
  });

  it('无活跃订阅时子进程退出 → 不重启(惰性 refork)', async () => {
    const { client, children, fork } = setup();
    const handle = await client.subscribe('D:/repo', [], vi.fn());
    await handle.unsubscribe();
    children[0].emitExit(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fork).toHaveBeenCalledTimes(1);
    expect(client.activeSubscriptionCount).toBe(0);
  });

  it('连续崩溃超限 → 降级:onError 通知、后续 subscribe 变 no-op', async () => {
    const { client, children, fork, log } = setup();
    const onError = vi.fn();
    await client.subscribe('D:/repo', [], vi.fn(), onError);

    // 6 轮崩溃(MAX_CONSECUTIVE_CRASHES=5,第 6 次触发降级)
    for (let i = 0; i < 6; i++) {
      children[children.length - 1].emitExit(1);
      await vi.advanceTimersByTimeAsync(11_000); // 覆盖最大退避 10s
    }
    expect(client.isDegraded).toBe(true);
    expect(onError).toHaveBeenCalledWith('watcher host degraded');
    expect(log.error).toHaveBeenCalled();

    const forkCountAtDegrade = fork.mock.calls.length;
    const noop = await client.subscribe('D:/other', [], vi.fn());
    expect(fork.mock.calls.length).toBe(forkCountAtDegrade); // 不再 fork
    await noop.unsubscribe(); // no-op 句柄可安全调用
  });

  it('subscribe RPC 建立阶段连续崩溃也会退避并最终降级', async () => {
    const { client, children, fork, log } = setup();

    for (let i = 0; i < 6; i++) {
      const p = client.subscribe('D:/repo', [], vi.fn());
      const child = children[children.length - 1];
      child.autoRespondOk = false;
      child.emitExit(1);
      await expect(p).rejects.toThrow(/watcher host exited/);
      await vi.advanceTimersByTimeAsync(11_000);
    }

    expect(client.isDegraded).toBe(true);
    expect(log.error).toHaveBeenCalled();
    const forkCountAtDegrade = fork.mock.calls.length;
    const noop = await client.subscribe('D:/other', [], vi.fn());
    expect(fork.mock.calls.length).toBe(forkCountAtDegrade);
    await noop.unsubscribe();
  });

  it('首个 subscribe RPC 超时也会退避并最终降级', async () => {
    const children: FakeChild[] = [];
    const fork = vi.fn(() => {
      const c = new FakeChild();
      c.autoRespondOk = false;
      children.push(c);
      return c;
    });
    const log = makeLog();
    const client = new WatcherHostClient({ fork, log });

    for (let i = 0; i < 6; i++) {
      const p = client.subscribe('D:/repo', [], vi.fn());
      const child = children[children.length - 1];
      const assertion = expect(p).rejects.toThrow(/watcher host rpc timeout: subscribe/);
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
      expect(child.killed).toBe(true);
      await vi.advanceTimersByTimeAsync(11_000);
    }

    expect(client.isDegraded).toBe(true);
    expect(log.error).toHaveBeenCalled();
    const forkCountAtDegrade = fork.mock.calls.length;
    const noop = await client.subscribe('D:/other', [], vi.fn());
    expect(fork.mock.calls.length).toBe(forkCountAtDegrade);
    await noop.unsubscribe();
  });

  it('重放订阅失败时通知该订阅 onError,并保留簿记等待后续恢复', async () => {
    const { client, children } = setup();
    const onError = vi.fn();
    await client.subscribe('D:/repo', [], vi.fn(), onError);

    children[0].emitExit(1);
    vi.advanceTimersByTime(500);
    const replay = children[1].sent.find((m) => m.op === 'subscribe');
    expect(replay).toBeTruthy();
    children[1].emit({ kind: 'response', id: replay!.id, ok: false, error: 'native refused' });
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith(expect.stringContaining('native refused'));
    });

    expect(client.activeSubscriptionCount).toBe(1);
  });

  it('重放订阅时 host 退出会中止当前 replay,等待已布置的退避重试', async () => {
    const { client, children, fork } = setup();
    await client.subscribe('D:/repo-a', [], vi.fn());
    await client.subscribe('D:/repo-b', [], vi.fn());

    children[0].emitExit(1);
    vi.advanceTimersByTime(500);
    const replayHost = children[1];
    const firstReplay = replayHost.sent.find((m) => m.op === 'subscribe');
    expect(firstReplay).toMatchObject({ dir: 'D:/repo-a' });
    replayHost.autoRespondOk = false;
    replayHost.emitExit(1);
    await vi.waitFor(() => {
      expect(replayHost.sent.filter((m) => m.op === 'subscribe')).toHaveLength(1);
    });

    expect(fork).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(fork).toHaveBeenCalledTimes(3);
    expect(children[2].sent.filter((m) => m.op === 'subscribe')).toHaveLength(2);
  });

  it('RPC 超时会 kill 卡死 host 并走退避重启路径', async () => {
    const { client, children, fork } = setup();
    const onEvents = vi.fn();
    await client.subscribe('D:/repo', [], onEvents);
    children[0].autoRespondOk = false;

    const unsubscribe = client.subscribe('D:/other', [], vi.fn());
    const assertion = expect(unsubscribe).rejects.toThrow(/watcher host rpc timeout: subscribe/);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(children[0].killed).toBe(true);

    await vi.advanceTimersByTimeAsync(600);
    expect(fork).toHaveBeenCalledTimes(2);
    expect(children[1].sent.find((m) => m.op === 'subscribe')).toMatchObject({ dir: 'D:/repo' });
    expect(client.activeSubscriptionCount).toBe(1);
  });

  it('unsubscribe:发 RPC 并从簿记移除;重复调用幂等', async () => {
    const { client, children } = setup();
    const handle = await client.subscribe('D:/repo', [], vi.fn());
    expect(client.activeSubscriptionCount).toBe(1);
    await handle.unsubscribe();
    expect(client.activeSubscriptionCount).toBe(0);
    expect(children[0].sent.some((m) => m.op === 'unsubscribe')).toBe(true);
    await handle.unsubscribe(); // 幂等
  });

  it('dispose:kill 子进程,退出事件不触发重启', async () => {
    const { client, children, fork } = setup();
    await client.subscribe('D:/repo', [], vi.fn());
    client.dispose();
    expect(children[0].killed).toBe(true);
    children[0].emitExit(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fork).toHaveBeenCalledTimes(1);
  });
});
