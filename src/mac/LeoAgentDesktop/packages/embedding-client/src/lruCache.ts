/**
 * 简单 LRU 缓存 (Map 自带插入顺序, 命中时 delete + set 把 key 挪到末尾)。
 *
 * 用途: EmbeddingClient 的内存缓存层, key = sha256(model + '\0' + text),
 * value = number[] (embedding 向量)。容量上限由 EmbeddingClientOptions.cacheSize
 * 控制, default 1000 条 (再大也兜不住, 真量级靠后续 Phase 的磁盘缓存)。
 */
export class LruCache<K, V> {
  private readonly store = new Map<K, V>();

  constructor(private readonly capacity: number) {}

  /** capacity <= 0 时本缓存退化为 no-op。 */
  get enabled(): boolean {
    return this.capacity > 0;
  }

  get size(): number {
    return this.store.size;
  }

  get(key: K): V | undefined {
    if (!this.enabled) return undefined;
    const v = this.store.get(key);
    if (v === undefined) return undefined;
    // 命中 → 挪到末尾 (LRU)
    this.store.delete(key);
    this.store.set(key, v);
    return v;
  }

  set(key: K, value: V): void {
    if (!this.enabled) return;
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, value);
    while (this.store.size > this.capacity) {
      // 删最旧的 (Map.keys() 迭代顺序 = 插入顺序)
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  clear(): void {
    this.store.clear();
  }
}
