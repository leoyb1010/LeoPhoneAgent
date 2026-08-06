import { describe, expect, it } from 'vitest';

import { createSessionRefreshSequence } from '../sessionRefreshSequence';
import { createSessionSnapshotPatchBuffer } from '../sessionSnapshotPatchBuffer';

describe('createSessionRefreshSequence', () => {
  it('只允许当前 session 最新发起的全量 refresh 应用结果', () => {
    const sequence = createSessionRefreshSequence();
    sequence.setSession('session-a');
    const first = sequence.begin('session-a')!;
    const second = sequence.begin('session-a')!;

    expect(sequence.isLatest('session-a', first)).toBe(false);
    expect(sequence.isLatest('session-a', second)).toBe(true);
  });

  it('已确认的 effort patch 会使当前 session 此前所有 GET 响应失效', () => {
    const sequence = createSessionRefreshSequence();
    sequence.setSession('session-a');
    const initialLoad = sequence.begin('session-a')!;
    sequence.invalidate('session-a');

    expect(sequence.isLatest('session-a', initialLoad)).toBe(false);
  });

  it('切到 session B 后拒绝 session A 的迟到 refresh，且不取消 B 的 GET', () => {
    const sequence = createSessionRefreshSequence();
    sequence.setSession('session-a');
    const requestA = sequence.begin('session-a')!;

    sequence.setSession('session-b');
    const requestB = sequence.begin('session-b')!;

    expect(sequence.begin('session-a')).toBeNull();
    sequence.invalidate('session-a');
    expect(sequence.isLatest('session-a', requestA)).toBe(false);
    expect(sequence.isLatest('session-b', requestB)).toBe(true);
  });

  it('切到远程 session 后旧本地回调不能创建可覆盖远程镜像的 snapshot', () => {
    const sequence = createSessionRefreshSequence();
    sequence.setSession('local-session');
    const staleLocalGet = sequence.begin('local-session')!;

    sequence.setSession('remote-session');

    expect(sequence.isCurrentSession('remote-session')).toBe(true);
    expect(sequence.begin('local-session')).toBeNull();
    expect(sequence.isLatest('local-session', staleLocalGet)).toBe(false);
  });

  it('快速 high → xhigh → high → xhigh 时旧响应不能覆盖最后一次点击', () => {
    const sequence = createSessionRefreshSequence();
    sequence.setSession('session-a');
    let renderedEffort: 'high' | 'xhigh';
    const pendingGets = [
      { request: sequence.begin('session-a')!, effort: 'high' },
      { request: sequence.begin('session-a')!, effort: 'xhigh' },
      { request: sequence.begin('session-a')!, effort: 'high' },
    ] as const;

    // 最后一次 xhigh 已持久化并由 callback merge 回 UI。
    sequence.invalidate('session-a');
    renderedEffort = 'xhigh';

    // 模拟三个旧 GET 乱序完成；它们都不得再整行覆盖 UI。
    for (const response of [pendingGets[1], pendingGets[0], pendingGets[2]]) {
      if (sequence.isLatest('session-a', response.request)) renderedEffort = response.effort;
    }

    expect(renderedEffort).toBe('xhigh');
  });

  it('终态为 high 时同样保留最后一次点击，而不是固定偏向 xhigh', () => {
    const sequence = createSessionRefreshSequence();
    sequence.setSession('session-a');
    const staleXhigh = sequence.begin('session-a')!;

    sequence.invalidate('session-a');
    let renderedEffort: 'high' | 'xhigh' = 'high';
    if (sequence.isLatest('session-a', staleXhigh)) renderedEffort = 'xhigh';

    expect(renderedEffort).toBe('high');
  });
});

interface TestSessionSnapshot {
  id: string;
  title: string;
  effort: string;
  status: string;
}

describe('createSessionSnapshotPatchBuffer', () => {
  it('基础 snapshot 为空时保留初始 GET，并把抢先到达的 patch 覆盖合并到完整 row', () => {
    const sequence = createSessionRefreshSequence();
    const patches = createSessionSnapshotPatchBuffer<TestSessionSnapshot>();
    sequence.setSession('session-a');
    patches.setSession('session-a');
    const initialGet = sequence.begin('session-a')!;

    // sessions:patched 先到：没有 base 时不 invalidate 唯一完整 GET，只暂存新字段。
    patches.stage('session-a', { effort: 'xhigh', status: 'active' });
    expect(sequence.isLatest('session-a', initialGet)).toBe(true);

    const merged = patches.merge('session-a', {
      id: 'session-a',
      title: '完整标题',
      effort: 'high',
      status: 'draft',
    });

    expect(merged).toEqual({
      id: 'session-a',
      title: '完整标题',
      effort: 'xhigh',
      status: 'active',
    });
  });

  it('list snapshot 中途出现后仍保留旧 patch，并等待唯一完整 GET', () => {
    const sequence = createSessionRefreshSequence();
    const patches = createSessionSnapshotPatchBuffer<TestSessionSnapshot>();
    sequence.setSession('session-a');
    patches.setSession('session-a');
    const initialGet = sequence.begin('session-a')!;

    patches.stage('session-a', { effort: 'xhigh' });
    const listView = patches.merge('session-a', {
      id: 'session-a',
      title: '列表标题',
      effort: 'high',
      status: 'draft',
    });
    expect(listView.effort).toBe('xhigh');

    patches.stage('session-a', { status: 'active' });
    expect(sequence.isLatest('session-a', initialGet)).toBe(true);
    expect(
      patches.merge('session-a', {
        id: 'session-a',
        title: '完整标题',
        effort: 'high',
        status: 'draft',
      }),
    ).toEqual({
      id: 'session-a',
      title: '完整标题',
      effort: 'xhigh',
      status: 'active',
    });
  });

  it('切换 session 时丢弃旧会话暂存 patch', () => {
    const patches = createSessionSnapshotPatchBuffer<TestSessionSnapshot>();
    patches.setSession('session-a');
    patches.stage('session-a', { effort: 'xhigh' });

    patches.setSession('session-b');
    const sessionB = patches.merge('session-b', {
      id: 'session-b',
      title: 'B',
      effort: 'high',
      status: 'active',
    });

    expect(sessionB.effort).toBe('high');
  });

  it('完整 GET 已排队但尚未 render 时到达的新 patch 仍可重复覆盖合并', () => {
    const patches = createSessionSnapshotPatchBuffer<TestSessionSnapshot>();
    patches.setSession('session-a');
    patches.stage('session-a', { effort: 'xhigh' });

    const queuedSnapshot = patches.merge('session-a', {
      id: 'session-a',
      title: '完整标题',
      effort: 'high',
      status: 'draft',
    });
    patches.stage('session-a', { status: 'active' });

    expect(patches.merge('session-a', queuedSnapshot)).toEqual({
      id: 'session-a',
      title: '完整标题',
      effort: 'xhigh',
      status: 'active',
    });
  });

  it('中断 render 不会消费 patch，重试提交后才确认清除', () => {
    const patches = createSessionSnapshotPatchBuffer<TestSessionSnapshot>();
    patches.setSession('session-a');
    patches.stage('session-a', { effort: 'xhigh' });
    const base = {
      id: 'session-a',
      title: '完整标题',
      effort: 'high',
      status: 'draft',
    };

    // 第一次 merge 模拟中断 render：没有 layout commit，不能确认这份 snapshot。
    expect(patches.merge('session-a', base).effort).toBe('xhigh');
    const committed = patches.merge('session-a', base);
    expect(committed.effort).toBe('xhigh');

    patches.acknowledgeCommitted('session-a', committed);
    expect(patches.merge('session-a', base)).toBe(base);
  });

  it('旧 committed snapshot 不能清掉确认前到达的更新 revision', () => {
    const patches = createSessionSnapshotPatchBuffer<TestSessionSnapshot>();
    patches.setSession('session-a');
    const base = {
      id: 'session-a',
      title: '完整标题',
      effort: 'high',
      status: 'draft',
    };

    patches.stage('session-a', { effort: 'xhigh' });
    const oldCommitted = patches.merge('session-a', base);
    patches.stage('session-a', { status: 'active' });
    patches.acknowledgeCommitted('session-a', oldCommitted);

    const latestCommitted = patches.merge('session-a', base);
    expect(latestCommitted).toEqual({
      id: 'session-a',
      title: '完整标题',
      effort: 'xhigh',
      status: 'active',
    });
    patches.acknowledgeCommitted('session-a', latestCommitted);
    expect(patches.merge('session-a', base)).toBe(base);
  });
});
