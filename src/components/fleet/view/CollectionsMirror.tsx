import { useCallback, useEffect, useState } from 'react';

import { apiClient } from '../../../utils/apiClient';

/**
 * [T-collections-fleet] 手机收藏的只读镜像。
 *
 * 收藏本体(附件、抓下来的正文)留在手机沙盒里,不复制出来;这里显示
 * 的是手机上传到中继的索引:标题、来源、摘要、标签、链接。想看原文
 * 就点链接。刻意只读 —— 在 Mac 上改收藏会引入双写冲突,不值当。
 */

type Item = {
  id: string;
  kind: string;
  title: string;
  url: string;
  source: string;
  summary: string;
  tags: string[];
  created_at: number;
};

export default function CollectionsMirror() {
  const [items, setItems] = useState<Item[]>([]);
  const [query, setQuery] = useState('');
  const [configured, setConfigured] = useState(true);
  const [updatedAt, setUpdatedAt] = useState(0);

  const load = useCallback(async () => {
    try {
      const data = await apiClient.get<{
        configured?: boolean;
        items?: Item[];
        updatedAt?: number;
      }>('/api/leophone/collections');
      setConfigured(data?.configured !== false);
      setItems(data?.items ?? []);
      setUpdatedAt(data?.updatedAt ?? 0);
    } catch {
      // 读不到就保持上一次的内容,不清空
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!configured) return null;

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const visible = terms.length
    ? items.filter((item) => {
        const hay = `${item.title} ${item.summary} ${item.source} ${item.tags.join(' ')}`.toLowerCase();
        return terms.every((term) => hay.includes(term));
      })
    : items;

  return (
    <section className="mt-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-foreground">手机收藏 · {items.length}</h2>
        {updatedAt > 0 && (
          <span className="text-xs text-muted-foreground">
            {new Date(updatedAt * 1000).toLocaleString()}
          </span>
        )}
      </div>

      {items.length > 0 && (
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索收藏"
          className="mt-2 h-8 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-primary"
        />
      )}

      <div className="mt-2 space-y-2">
        {items.length === 0 && (
          <p className="text-sm text-muted-foreground">
            手机上还没有收藏,或者手机还没同步过来。
          </p>
        )}
        {visible.map((item) => (
          <div key={item.id} className="rounded-md border border-border p-3">
            <div className="flex items-baseline gap-2">
              <span className="text-xs text-muted-foreground">{item.source}</span>
              <span className="text-xs text-muted-foreground opacity-60">
                {new Date(item.created_at * 1000).toLocaleDateString()}
              </span>
            </div>
            {item.url ? (
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 block text-sm text-foreground hover:underline"
              >
                {item.title || item.url}
              </a>
            ) : (
              <p className="mt-1 text-sm text-foreground">{item.title || '(无标题)'}</p>
            )}
            {item.summary && (
              <p className="mt-1 text-xs text-muted-foreground">{item.summary}</p>
            )}
            {item.tags.length > 0 && (
              <p className="mt-1 text-xs text-muted-foreground opacity-70">
                {item.tags.map((tag) => `#${tag}`).join(' ')}
              </p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
