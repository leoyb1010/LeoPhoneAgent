import { describe, expect, it, vi } from 'vitest';

import { createGhostCardThemeVarsStore } from '../useGhostCardThemeVars';

/** observe 的记录型 mock:捕获 onChange 供测试手动触发主题变化;记录起/停次数。 */
function mockObserve() {
  const state = { starts: 0, stops: 0, fire: (): void => {} };
  const observe = (onChange: () => void) => {
    state.starts++;
    state.fire = onChange;
    return () => {
      state.stops++;
    };
  };
  return { state, observe };
}

describe('createGhostCardThemeVarsStore · 卡片主题变量外部 store', () => {
  it('getSnapshot 惰性首算,返回构建器结果', () => {
    const build = vi.fn(() => ':root { --surface: #fff; }');
    const store = createGhostCardThemeVarsStore(build, () => () => {});
    expect(build).not.toHaveBeenCalled(); // 未读取前不算
    expect(store.getSnapshot()).toBe(':root { --surface: #fff; }');
    expect(build).toHaveBeenCalledTimes(1);
    store.getSnapshot(); // 已缓存,不重算
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('首个订阅者才起 observer,订阅者清空后收工', () => {
    const { state, observe } = mockObserve();
    const store = createGhostCardThemeVarsStore(() => 'x', observe);
    const un1 = store.subscribe(() => {});
    expect(state.starts).toBe(1);
    const un2 = store.subscribe(() => {});
    expect(state.starts).toBe(1); // 第二个订阅者复用同一 observer
    un1();
    expect(state.stops).toBe(0); // 还有订阅者,不收工
    un2();
    expect(state.stops).toBe(1); // 最后一个走了才停
  });

  it('token 变了才广播,没变不惊动订阅者', () => {
    let css = 'a';
    const { state, observe } = mockObserve();
    const store = createGhostCardThemeVarsStore(() => css, observe);
    store.getSnapshot(); // React 首渲先读快照 → cachedVars 已是 'a'
    const cb = vi.fn();
    store.subscribe(cb); // 订阅时补算 no-op(值未变),不广播
    expect(cb).not.toHaveBeenCalled();
    // 主题无关翻动:值没变 → 不广播
    state.fire();
    expect(cb).not.toHaveBeenCalled();
    // 真换肤:值变 → 广播一次,snapshot 更新
    css = 'b';
    state.fire();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toBe('b');
  });

  it('重订阅补算:全下线期间换过主题,新订阅者拿到当前值', () => {
    let css = 'light';
    const { state, observe } = mockObserve();
    const store = createGhostCardThemeVarsStore(() => css, observe);
    const un = store.subscribe(() => {});
    expect(store.getSnapshot()).toBe('light');
    un(); // 卡片全下线,observer 停
    css = 'dark'; // 下线期间用户切了主题
    const cb = vi.fn();
    store.subscribe(cb); // 新卡挂载重订阅 → 补算一次
    expect(cb).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toBe('dark');
  });
});
