/**
 * scheduleSessionBinding — sessionId → Schedule[] 反向索引纯函数测试。
 *
 * Cover 的关键设计点:
 *   1. 同一输入引用返回同一 Map 引用(模块级 memo,百级 SessionItem 共享构建)。
 *   2. expired 滤掉、paused 保留(徽章弱化态依赖)。
 *   3. 多 schedule 绑同一 session 聚合为数组。
 *   4. null / 无 targetSessionId 输入返回空 Map。
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { Schedule } from '@cindy/maker-scheduler';

import {
  buildBindingMap,
  __resetBindingMemoForTest,
} from '../scheduleSessionBinding';

function makeSchedule(overrides: Partial<Schedule>): Schedule {
  return {
    id: 'sch-1',
    name: 'follow-up',
    status: 'active',
    targetSessionId: undefined,
    ...overrides,
  } as Schedule;
}

describe('buildBindingMap', () => {
  beforeEach(() => {
    __resetBindingMemoForTest();
  });

  it('同一输入引用返回同一 Map 引用', () => {
    const input = [makeSchedule({ targetSessionId: 'sess-a' })];
    const first = buildBindingMap(input);
    const second = buildBindingMap(input);
    expect(second).toBe(first);
  });

  it('输入引用变化后重建 Map', () => {
    const first = buildBindingMap([makeSchedule({ targetSessionId: 'sess-a' })]);
    const second = buildBindingMap([makeSchedule({ targetSessionId: 'sess-a' })]);
    expect(second).not.toBe(first);
    expect(second.get('sess-a')).toHaveLength(1);
  });

  it('expired 滤掉,paused 保留', () => {
    const map = buildBindingMap([
      makeSchedule({ id: 'sch-1', targetSessionId: 'sess-a', status: 'expired' }),
      makeSchedule({ id: 'sch-2', targetSessionId: 'sess-b', status: 'paused' }),
    ]);
    expect(map.has('sess-a')).toBe(false);
    expect(map.get('sess-b')?.[0]?.id).toBe('sch-2');
  });

  it('多 schedule 绑同一 session 聚合', () => {
    const map = buildBindingMap([
      makeSchedule({ id: 'sch-1', targetSessionId: 'sess-a' }),
      makeSchedule({ id: 'sch-2', targetSessionId: 'sess-a', status: 'paused' }),
      makeSchedule({ id: 'sch-3', targetSessionId: 'sess-b' }),
    ]);
    expect(map.get('sess-a')?.map((s) => s.id)).toEqual(['sch-1', 'sch-2']);
    expect(map.get('sess-b')?.map((s) => s.id)).toEqual(['sch-3']);
  });

  it('null 输入与无 targetSessionId 的 schedule 都不产生条目', () => {
    expect(buildBindingMap(null).size).toBe(0);
    __resetBindingMemoForTest();
    const map = buildBindingMap([makeSchedule({ targetSessionId: undefined })]);
    expect(map.size).toBe(0);
  });
});
