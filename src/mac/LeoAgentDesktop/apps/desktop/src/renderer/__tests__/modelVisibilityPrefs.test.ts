/**
 * modelVisibilityPrefs.test.ts
 * ---------------------------------------------------------------------------
 * 回归 state/modelVisibilityPrefs.ts 的核心约定:
 *   1. 无 override → 跟随目录默认值(defaultEnabled 缺省=开 / =false 默认关 / =true 默认开)
 *   2. set override 覆盖目录默认(把默认开的关掉 / 把默认关的打开)
 *   3. set/get 往返 + localStorage 持久化(模拟 app 重启)
 *   4. 按 (agent, providerId, modelId) 分槽:同名模型在 cc / codex 互不覆盖
 *   5. setManyVisibility 批量(全部关 / 全部开)写显式 override
 *   6. 同值写入短路(不抛)
 *   7. schema 损坏 / 脏数据 → 静默回退,跟随目录默认
 *
 * 项目 vitest env=node,无 window。沿用 providerModelMemory.test.ts 的最小 localStorage stub。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

class MemLocalStorage {
  private store = new Map<string, string>();
  getItem(k: string): string | null {
    return this.store.has(k) ? (this.store.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.store.set(k, v);
  }
  removeItem(k: string): void {
    this.store.delete(k);
  }
  clear(): void {
    this.store.clear();
  }
}

let memStorage: MemLocalStorage;

beforeEach(() => {
  memStorage = new MemLocalStorage();
  vi.stubGlobal('window', { localStorage: memStorage });
  vi.stubGlobal('localStorage', memStorage);
  vi.resetModules();
});

async function loadModule() {
  return await import('@/state/modelVisibilityPrefs');
}

describe('modelVisibilityPrefs store', () => {
  it('无 override:跟随目录默认值(缺省=开 / false=关 / true=开)', async () => {
    const { isModelEnabled } = await loadModule();
    // defaultEnabled 缺省 → 开
    expect(isModelEnabled('claude-code', 'xd', { id: 'claude-opus-4-8' })).toBe(true);
    // defaultEnabled: true → 开
    expect(isModelEnabled('claude-code', 'xd', { id: 'a', defaultEnabled: true })).toBe(true);
    // defaultEnabled: false → 默认关(目录把它标成默认隐藏)
    expect(isModelEnabled('claude-code', 'xd', { id: 'b', defaultEnabled: false })).toBe(false);
  });

  it('set override 覆盖目录默认:默认开的关掉、默认关的打开', async () => {
    const { isModelEnabled, setModelVisibility } = await loadModule();
    // 默认开 → 用户关
    setModelVisibility('claude-code', 'xd', 'claude-opus-4-8', false);
    expect(isModelEnabled('claude-code', 'xd', { id: 'claude-opus-4-8' })).toBe(false);
    // 默认关(defaultEnabled:false)→ 用户开
    setModelVisibility('claude-code', 'xd', 'b', true);
    expect(isModelEnabled('claude-code', 'xd', { id: 'b', defaultEnabled: false })).toBe(true);
  });

  it('set/get 往返 + 跨重启持久化', async () => {
    const m1 = await loadModule();
    m1.setModelVisibility('codex', 'xd', 'gpt-5.5', false);
    expect(m1.isModelEnabled('codex', 'xd', { id: 'gpt-5.5' })).toBe(false);

    vi.resetModules();
    const m2 = await loadModule();
    expect(m2.isModelEnabled('codex', 'xd', { id: 'gpt-5.5' })).toBe(false);
  });

  it('按 (agent, providerId, modelId) 分槽:同名 gpt-5.5 在 cc / codex 互不覆盖', async () => {
    const { isModelEnabled, setModelVisibility } = await loadModule();
    setModelVisibility('claude-code', 'xd', 'gpt-5.5', false); // cc 下关掉
    // codex 下不受影响,仍跟随默认(开)
    expect(isModelEnabled('claude-code', 'xd', { id: 'gpt-5.5' })).toBe(false);
    expect(isModelEnabled('codex', 'xd', { id: 'gpt-5.5' })).toBe(true);
  });

  it('同一来源不同 provider 互不影响(xd vs openai)', async () => {
    const { isModelEnabled, setModelVisibility } = await loadModule();
    setModelVisibility('codex', 'xd', 'gpt-5.5', false);
    expect(isModelEnabled('codex', 'xd', { id: 'gpt-5.5' })).toBe(false);
    expect(isModelEnabled('codex', 'openai', { id: 'gpt-5.5' })).toBe(true);
  });

  it('setManyVisibility:全部关 → 全部开,写显式 override(含目录默认关的也被打开)', async () => {
    const { isModelEnabled, setManyVisibility } = await loadModule();
    const ids = ['claude-opus-4-8', 'claude-sonnet-4-6', 'b'];
    setManyVisibility('claude-code', 'xd', ids, false);
    for (const id of ids) {
      expect(isModelEnabled('claude-code', 'xd', { id })).toBe(false);
    }
    setManyVisibility('claude-code', 'xd', ids, true);
    // 即便 'b' 目录默认是关,「全部开启」也把它显式打开
    expect(isModelEnabled('claude-code', 'xd', { id: 'b', defaultEnabled: false })).toBe(true);
    expect(isModelEnabled('claude-code', 'xd', { id: 'claude-opus-4-8' })).toBe(true);
  });

  it('同值写入短路:不抛,值保持', async () => {
    const { isModelEnabled, setModelVisibility } = await loadModule();
    setModelVisibility('codex', 'openai', 'gpt-5.4', false);
    expect(() => setModelVisibility('codex', 'openai', 'gpt-5.4', false)).not.toThrow();
    expect(isModelEnabled('codex', 'openai', { id: 'gpt-5.4' })).toBe(false);
  });

  it('空 providerId / modelId 入参被忽略', async () => {
    const { isModelEnabled, setModelVisibility } = await loadModule();
    setModelVisibility('claude-code', '', 'x', false);
    setModelVisibility('claude-code', 'xd', '', false);
    // 都没写进去 → 仍跟随默认(开)
    expect(isModelEnabled('claude-code', 'xd', { id: 'x' })).toBe(true);
  });

  it('schema 损坏的 localStorage → 静默回退,跟随目录默认', async () => {
    memStorage.setItem('xdt:modelVisibilityPrefs:v1', '{ not valid json');
    vi.resetModules();
    const { isModelEnabled } = await loadModule();
    expect(isModelEnabled('claude-code', 'xd', { id: 'claude-opus-4-8' })).toBe(true);
  });

  it('脏数据条目(value 非 boolean)被过滤', async () => {
    memStorage.setItem(
      'xdt:modelVisibilityPrefs:v1',
      JSON.stringify({
        'claude-code:xd:claude-opus-4-8': false, // 合法
        'claude-code:xd:claude-sonnet-4-6': 'nope', // 非 boolean → 丢弃
        'codex:xd:gpt-5.5': 1, // 非 boolean → 丢弃
      }),
    );
    vi.resetModules();
    const { isModelEnabled } = await loadModule();
    expect(isModelEnabled('claude-code', 'xd', { id: 'claude-opus-4-8' })).toBe(false); // 合法 override 生效
    expect(isModelEnabled('claude-code', 'xd', { id: 'claude-sonnet-4-6' })).toBe(true); // 脏数据丢弃 → 默认开
    expect(isModelEnabled('codex', 'xd', { id: 'gpt-5.5' })).toBe(true); // 脏数据丢弃 → 默认开
  });
});
