/**
 * infoDedupe.ts — in-flight dedupe + SWR 缓存 for skillhub info requests
 *
 * 三层数据结构:
 *   - inFlight: Map<name, Promise>  并发去重,promise resolve 后立即删
 *   - lastResults: Map<name, result> SWR 缓存,用于切 skill 时立刻渲染
 *   - lastDeleted: Map<name, boolean> 标记 server 是否显式返回 404(已删除)
 *
 * SWR 模式:render 阶段从 lastResults 拿到上次结果立刻渲染,后台异步 getInfo
 * 仍然照跑,新结果回来后再 setState 修正。
 * 网络错误时不覆盖 lastResults/lastDeleted,保留 stale 数据(真正的 SWR 语义)。
 */

const inFlight = new Map<string, Promise<SkillhubInfoResult | null>>();
const lastResults = new Map<string, SkillhubInfoResult | null>();
const lastDeleted = new Map<string, boolean>();

function fetchInfo(name: string): Promise<SkillhubInfoResult | null> {
  const p = window.electronAPI.skillhub
    .info(name)
    .then((res) => {
      if (res.success && res.info && 'isMine' in res.info) {
        const info = res.info as SkillhubInfoResult;
        lastResults.set(name, info);
        lastDeleted.set(name, false);
        return info;
      }
      if (res.success && res.deleted) {
        lastResults.set(name, null);
        lastDeleted.set(name, true);
        return null;
      }
      // error (!res.success): preserve stale cache (SWR)
      return lastResults.get(name) ?? null;
    })
    .catch(() => {
      // network error: preserve stale cache
      return lastResults.get(name) ?? null;
    })
    .finally(() => {
      if (inFlight.get(name) === p) inFlight.delete(name);
    });

  inFlight.set(name, p);
  return p;
}

export function getInfo(name: string): Promise<SkillhubInfoResult | null> {
  const existing = inFlight.get(name);
  if (existing) return existing;

  return fetchInfo(name);
}

/** Force one network refresh while keeping stale cache as the failure fallback. */
export function refreshInfo(name: string): Promise<SkillhubInfoResult | null> {
  return fetchInfo(name);
}

/** 同步读上次拿到的 info(用于 render 阶段 seed state,实现切 skill 不闪)。 */
export function getCachedInfo(name: string): SkillhubInfoResult | null {
  return lastResults.get(name) ?? null;
}

/** Server 是否显式返回 404(skill 已从市场删除)。 */
export function isMarketDeleted(name: string): boolean {
  return lastDeleted.get(name) ?? false;
}

/** Force re-fetch on next call (e.g. after publish success). */
export function invalidate(name: string): void {
  inFlight.delete(name);
  lastResults.delete(name);
  lastDeleted.delete(name);
}
