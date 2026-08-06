/**
 * useGhostCardThemeVars — 意识卡片(iframe srcDoc)的主题变量订阅。
 *
 * 卡片是海量、静态、钉在时间线上的历史件,不能像面板那样用 webview + insertCSS
 * 热注入(每张一个进程扛不住,见 GhostToolCard 顶注的宿主取舍)。改走 srcDoc
 * 内联:把主机当前主题的白名单 token 编成一段 `:root{...}` 注进卡片 <head>,
 * 意识内容用同名 var(--xxx) 就能跟主机主题(light/dark/扩展主题皆可);写死
 * 配色的意识不引用这些 var,纯加法、完全不受影响(规则 24 的"给实现的可能性")。
 *
 * 主题切换时变量块变更 → srcDoc 变更 → iframe 原地重载(切主题是低频操作,
 * 重载可接受;内容布局不变、量高得同值,无可见跳动)。用外部 store + 单一
 * MutationObserver 给全部卡片共享一份订阅,避免每张卡各挂一个 observer。
 */

import { useSyncExternalStore } from 'react';

import { buildGhostThemeVarsBlock, observeHostTheme } from './ghostPanelTheme';

/** useSyncExternalStore 需要的外部 store 契约。 */
export interface GhostCardThemeVarsStore {
  subscribe(cb: () => void): () => void;
  getSnapshot(): string;
}

/**
 * 主题变量外部 store(抽成工厂便于独立单测,与 createGhostThemeInjector 同款):
 * - 单一 observer 给全部订阅者共享:首个订阅者到场才起、清空后收工;
 * - token 文本没变不广播:换肤监听会被 root 上与主题无关的 class/style 翻动
 *   连环触发,值未变时提前返回,getSnapshot 返回同串 → React 用 Object.is
 *   判定无变化、不重渲(避免无谓的 iframe 重载);
 * - 惰性首算 + 重订阅补算:卡片全下线期间可能换过主题,重新有卡挂载时补算
 *   一次,新卡拿到当前主题而非陈旧值。
 */
export function createGhostCardThemeVarsStore(
  buildVars: () => string = buildGhostThemeVarsBlock,
  observe: (onChange: () => void) => () => void = observeHostTheme,
): GhostCardThemeVarsStore {
  let cachedVars: string | null = null;
  const subscribers = new Set<() => void>();
  let stopObserving: (() => void) | null = null;

  const recompute = (): void => {
    const next = buildVars();
    if (next === cachedVars) return;
    cachedVars = next;
    for (const cb of subscribers) cb();
  };

  return {
    subscribe(cb) {
      subscribers.add(cb);
      if (!stopObserving) {
        stopObserving = observe(recompute);
        recompute();
      }
      return () => {
        subscribers.delete(cb);
        if (subscribers.size === 0 && stopObserving) {
          stopObserving();
          stopObserving = null;
        }
      };
    },
    getSnapshot() {
      if (cachedVars === null) cachedVars = buildVars();
      return cachedVars;
    },
  };
}

/** 进程内单例:全部卡片共享一份订阅。 */
const sharedStore = createGhostCardThemeVarsStore();

/** 返回当前主题的 `:root{--token:value;…}` 变量块;主题切换时自动刷新触发重渲。 */
export function useGhostCardThemeVars(): string {
  return useSyncExternalStore(sharedStore.subscribe, sharedStore.getSnapshot);
}
