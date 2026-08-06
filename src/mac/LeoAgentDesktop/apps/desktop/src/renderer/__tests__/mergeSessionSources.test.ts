/**
 * mergeSessionSources 单测 —— 合并本地 + device-link 远程镜像会话源。
 * 守住远程 orca lead/worker 能被 orca 路由/视图解析到(本地优先、远程补充、引用稳定)。
 */
import { describe, expect, it } from 'vitest';
import type { Session } from '@/lib/ccAgent.types';
import { mergeSessionSources } from '@/features/cc-agent/lib/mergeSessionSources';

const sess = (id: string, extra?: Partial<Session>): Session =>
  ({ id, title: id, ...extra }) as unknown as Session;

describe('mergeSessionSources', () => {
  it('remote 为空 → 原样返回 local(同引用,零重渲染)', () => {
    const local = [sess('a'), sess('b')];
    expect(mergeSessionSources(local, [])).toBe(local);
  });

  it('远程会话补充进来(本地没有的 id)', () => {
    const local = [sess('a')];
    const remote = [sess('r1'), sess('r2')];
    expect(mergeSessionSources(local, remote).map((s) => s.id)).toEqual(['a', 'r1', 'r2']);
  });

  it('同 id 时本地优先,远程那条被丢弃', () => {
    const local = [sess('dup', { title: 'local-version' })];
    const remote = [sess('dup', { title: 'remote-version' }), sess('r1')];
    const merged = mergeSessionSources(local, remote);
    expect(merged.map((s) => s.id)).toEqual(['dup', 'r1']);
    expect(merged.find((s) => s.id === 'dup')?.title).toBe('local-version');
  });

  it('本地为空 + 远程有 → 仅远程(远程 orca lead 可被解析)', () => {
    const remote = [sess('remote-lead', { orcaRole: 'lead' })];
    const merged = mergeSessionSources([], remote);
    expect(merged.map((s) => s.id)).toEqual(['remote-lead']);
    expect(merged[0].orcaRole).toBe('lead');
  });
});
