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
  archived?: boolean;
  annotation?: string;
};

export default function CollectionsMirror({ refreshTick = 0 }: { refreshTick?: number }) {
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

  // 同页的机器和审批 15 秒一刷,收藏跟着同一节拍——不能一活一死
  useEffect(() => {
    void load();
  }, [load, refreshTick]);

  if (!configured) return null;

  // 手机上归档的条目这里也收起来 —— 两端看到的应该是同一个库
  const active = items.filter((item) => !item.archived);
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const visible = terms.length
    ? active.filter((item) => {
        const hay = `${item.title} ${item.summary} ${item.source} ${item.tags.join(' ')} ${item.annotation ?? ''}`.toLowerCase();
        return terms.every((term) => hay.includes(term));
      })
    : active;

  return (
    <section className="mt-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-foreground">手机收藏 · {active.length}</h2>
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
              <p className="mt-1 text-sm text-foreground">
                {item.kind === 'note' && (
                  <span className="mr-1.5 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    笔记
                  </span>
                )}
                {item.title || '(无标题)'}
              </p>
            )}
            {item.summary && (
              <p className="mt-1 text-xs text-muted-foreground">{item.summary}</p>
            )}
            {item.annotation && (
              <p className="mt-1 border-l-2 border-border pl-2 text-xs text-muted-foreground"
                 style={{ borderRadius: 0 }}>
                批注:{item.annotation}
              </p>
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
