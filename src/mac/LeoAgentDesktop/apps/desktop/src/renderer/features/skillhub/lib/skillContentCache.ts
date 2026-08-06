/**
 * skillContentCache.ts — module-level LRU 缓存 .md / sibling 文件正文,
 * 给 detail view 的 useState 同步 seed,避免「读取内容…」占位帧。
 *
 * 拎到独立模块的原因:sidebar 的 EntryRow 点击 handler 需要在 navigate 之前
 * 把内容预热进来,不然 detail view 第一帧仍会 miss → 看到一闪。
 *
 * 失败信息单独走 contentErrorCache,因为正文为空字符串是合法状态(空 .md),
 * 不能用 ""/null 区分「成功但空」与「失败」。
 */

const MAX_CONTENT_CACHE = 50;

const contentCache = new Map<string, string>();
const contentErrorCache = new Map<string, string>();

export function getCachedContent(key: string): string | null {
  return contentCache.get(key) ?? null;
}

export function getCachedContentError(key: string): string | null {
  return contentErrorCache.get(key) ?? null;
}

export function hasCachedContent(key: string): boolean {
  return contentCache.has(key) || contentErrorCache.has(key);
}

export function setCachedContent(key: string, value: string): void {
  contentCache.delete(key);
  contentCache.set(key, value);
  // 一旦写入成功内容,就要清掉同 key 的旧错误,否则 hasCachedContent 命中错误分支
  contentErrorCache.delete(key);
  evictIfNeeded(contentCache);
}

export function setCachedContentError(key: string, value: string): void {
  contentErrorCache.delete(key);
  contentErrorCache.set(key, value);
  evictIfNeeded(contentErrorCache);
}

export function deleteCachedContent(key: string): void {
  contentCache.delete(key);
  contentErrorCache.delete(key);
}

function evictIfNeeded(map: Map<string, string>): void {
  if (map.size > MAX_CONTENT_CACHE) {
    const oldest = map.keys().next().value!;
    map.delete(oldest);
  }
}

/**
 * 预拉 skill 主 .md 文件正文写入缓存。供 sidebar 点击 cell 时调用,
 * 让 detail view 第一帧就能从缓存同步拿到正文,避免「读取内容…」占位帧。
 * 已缓存就 no-op。失败静默(detail view 的 useEffect 还会再试)。
 */
export async function prefetchSkillContent(mdPath: string): Promise<void> {
  if (!mdPath) return;
  if (hasCachedContent(mdPath)) return;
  try {
    const isMarkdown = mdPath.toLowerCase().endsWith('.md');
    const res = isMarkdown
      ? await window.electronAPI.skillhub.readSkill({ mdPath })
      : await window.electronAPI.skillhub.readSiblingFile({ filePath: mdPath });
    if (res.success) {
      setCachedContent(mdPath, res.content ?? '');
    } else if (res.error) {
      setCachedContentError(mdPath, res.error);
    }
  } catch {
    /* swallow — detail view 的 useEffect 会再次尝试并报错 */
  }
}
