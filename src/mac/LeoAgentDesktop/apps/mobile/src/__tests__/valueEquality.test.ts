import { describe, expect, it } from 'vitest';
import { dataPropsEqual, deepValueEqual, mapContentEqual } from '@/utils/valueEquality';

describe('deepValueEqual', () => {
  it('原始值与引用快路径', () => {
    expect(deepValueEqual(1, 1)).toBe(true);
    expect(deepValueEqual('a', 'b')).toBe(false);
    const obj = { a: 1 };
    expect(deepValueEqual(obj, obj)).toBe(true);
  });

  it('新引用但内容相同的对象/数组判等', () => {
    expect(deepValueEqual({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] })).toBe(true);
    expect(deepValueEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepValueEqual([1, 2], [2, 1])).toBe(false);
  });

  it('函数只有同引用才判等(安全侧:比不出相等就走重建路径)', () => {
    const fn = () => {};
    expect(deepValueEqual(fn, fn)).toBe(true);
    expect(deepValueEqual(fn, () => {})).toBe(false);
  });

  it('双侧循环引用(不可序列化)不判等——不许静默吞掉真实变化', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    const b: Record<string, unknown> = {};
    b.self = b;
    expect(deepValueEqual(a, b)).toBe(false);
  });
});

describe('mapContentEqual', () => {
  it('键值内容一致的新 Map 判等;键缺失 / 值不同 / 大小不同判不等', () => {
    const a = new Map([['x', { n: 1 }], ['y', { n: 2 }]]);
    expect(mapContentEqual(a, new Map([['x', { n: 1 }], ['y', { n: 2 }]]))).toBe(true);
    expect(mapContentEqual(a, new Map([['x', { n: 1 }], ['z', { n: 2 }]]))).toBe(false);
    expect(mapContentEqual(a, new Map([['x', { n: 1 }], ['y', { n: 3 }]]))).toBe(false);
    expect(mapContentEqual(a, new Map([['x', { n: 1 }]]))).toBe(false);
  });
});

describe('dataPropsEqual(React.memo 比较器)', () => {
  it('数据 props 深比较,函数 props 跳过(闭包语义稳定由使用处审计保证)', () => {
    const item = { session: { id: 's1', title: 'T' }, count: 2 };
    expect(dataPropsEqual(
      { item, testID: 'row', onOpen: () => {} },
      { item: { session: { id: 's1', title: 'T' }, count: 2 }, testID: 'row', onOpen: () => {} },
    )).toBe(true);
    expect(dataPropsEqual(
      { item, testID: 'row' },
      { item: { session: { id: 's1', title: 'X' }, count: 2 }, testID: 'row' },
    )).toBe(false);
  });

  it('props 形状变化(一侧函数缺席 / 新增数据键)判不等', () => {
    expect(dataPropsEqual({ onOpen: () => {} }, { onOpen: undefined })).toBe(false);
    expect(dataPropsEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });
});
