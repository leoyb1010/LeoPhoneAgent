import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { apiClient } from '../../../utils/apiClient';

type RemoteItem = {
  id: string; kind: string; title: string; url: string; source: string;
  summary: string; tags: string[]; created_at: number; archived?: boolean; annotation?: string;
};

type LocalItem = {
  id: string; kind: string; title: string | null; source_uri: string | null;
  source_label: string; summary: string | null; snippet: string;
  tags: string[]; created_at: string; archived: boolean; processing_state: string;
};

type DisplayItem = {
  id: string; kind: string; title: string; url: string; source: string; summary: string;
  tags: string[]; createdAt: number; archived: boolean; annotation: string; location: 'Mac' | '手机';
};

export default function CollectionsMirror({ refreshTick = 0 }: { refreshTick?: number }) {
  const [remoteItems, setRemoteItems] = useState<RemoteItem[]>([]);
  const [localItems, setLocalItems] = useState<LocalItem[]>([]);
  const [query, setQuery] = useState('');
  const [captureValue, setCaptureValue] = useState('');
  const [updatedAt, setUpdatedAt] = useState(0);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const [remote, local] = await Promise.allSettled([
      apiClient.get<{ items?: RemoteItem[]; updatedAt?: number }>('/api/leophone/collections'),
      apiClient.get<{ items?: LocalItem[] }>('/api/treasury', query ? { q: query, limit: 200 } : { limit: 200 }),
    ]);
    if (remote.status === 'fulfilled') {
      setRemoteItems(remote.value.items ?? []);
      setUpdatedAt(remote.value.updatedAt ?? 0);
      setRemoteError(null);
    } else {
      setRemoteError(remote.reason instanceof Error ? remote.reason.message : '手机收藏同步失败');
    }
    if (local.status === 'fulfilled') {
      setLocalItems(local.value.items ?? []);
      setLocalError(null);
    } else {
      setLocalError(local.reason instanceof Error ? local.reason.message : 'Mac 藏宝阁读取失败');
    }
  }, [query]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 180);
    return () => window.clearTimeout(timer);
  }, [load, refreshTick]);

  const visible = useMemo<DisplayItem[]>(() => {
    const local: DisplayItem[] = localItems.map((item) => ({
      id: `local:${item.id}`, kind: item.kind, title: item.title || item.source_label,
      url: item.source_uri || '', source: item.source_label,
      summary: item.summary || item.snippet || '', tags: item.tags,
      createdAt: Date.parse(item.created_at), archived: item.archived, annotation: '', location: 'Mac',
    }));
    const remote: DisplayItem[] = remoteItems.map((item) => ({
      id: `remote:${item.id}`, kind: item.kind, title: item.title || item.url || '(无标题)',
      url: item.url, source: item.source, summary: item.summary, tags: item.tags,
      createdAt: item.created_at * 1000, archived: Boolean(item.archived),
      annotation: item.annotation || '', location: '手机',
    }));
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return [...local, ...remote]
      .filter((item) => !item.archived)
      .filter((item) => !terms.length || terms.every((term) =>
        `${item.title} ${item.summary} ${item.source} ${item.tags.join(' ')} ${item.annotation}`.toLocaleLowerCase().includes(term)))
      .sort((left, right) => right.createdAt - left.createdAt);
  }, [localItems, query, remoteItems]);

  const saveTextOrUrl = useCallback(async () => {
    const content = captureValue.trim();
    if (!content) return;
    setSaving(true);
    try {
      const kind = /^https?:\/\/\S+$/i.test(content) ? 'link' : 'text';
      await apiClient.post('/api/treasury', { kind, content });
      setCaptureValue('');
      await load();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }, [captureValue, load]);

  const uploadFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setSaving(true);
    const form = new FormData();
    files.slice(0, 20).forEach((file) => form.append('files', file));
    try {
      const response = await apiClient.raw('/api/treasury/files', { method: 'POST', body: form });
      await response.json();
      await load();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : '文件保存失败');
    } finally {
      setSaving(false);
    }
  }, [load]);

  return (
    <section className="mt-6" aria-labelledby="treasury-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 id="treasury-heading" className="text-sm font-medium text-foreground">藏宝阁 · {visible.length}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Mac 本机优先保存；手机离线时保留最后一次成功内容。</p>
        </div>
        {updatedAt > 0 && <span className="text-xs text-muted-foreground">手机索引 {new Date(updatedAt * 1000).toLocaleString()}</span>}
      </div>

      <div
        className="mt-3 rounded-xl border border-dashed border-border bg-muted/25 p-3"
        role="group"
        aria-label="保存到 Mac 藏宝阁"
        aria-busy={saving}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => { event.preventDefault(); void uploadFiles(Array.from(event.dataTransfer.files)); }}
      >
        <div className="flex flex-col gap-2 sm:flex-row">
          <textarea
            value={captureValue}
            onChange={(event) => setCaptureValue(event.target.value)}
            placeholder="粘贴 URL 或文字，先保存，稍后再增强"
            aria-label="要保存的链接或文字"
            rows={2}
            className="min-h-16 flex-1 resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
          />
          <div className="flex shrink-0 gap-2 sm:flex-col">
            <button
              type="button"
              disabled={saving || !captureValue.trim()}
              onClick={() => void saveTextOrUrl()}
              className="min-h-10 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-45"
            >
              {saving ? '保存中…' : '收进藏宝阁'}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => fileInput.current?.click()}
              className="min-h-10 rounded-lg border border-border bg-background px-4 text-sm text-foreground disabled:opacity-45"
            >
              选择文件
            </button>
            <input ref={fileInput} type="file" multiple className="hidden" onChange={(event) => {
              void uploadFiles(Array.from(event.target.files ?? []));
              event.currentTarget.value = '';
            }} />
          </div>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">也可以把文件拖到这里。单文件上限 100 MB；原文件保存不依赖网络、OCR 或模型。</p>
      </div>

      {(remoteError || localError) && (
        <div role="status" className="mt-2 space-y-1 rounded-lg border border-warning/35 bg-warning/10 px-3 py-2 text-xs text-warning">
          {remoteError && <p>手机暂时离线，以下手机条目是上次成功内容。{remoteError}</p>}
          {localError && <p>Mac 本机藏宝阁出现错误：{localError}</p>}
        </div>
      )}

      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="搜索 Mac 与手机收藏"
        aria-label="搜索 Mac 与手机藏宝阁"
        className="mt-3 h-9 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary"
      />

      <div className="mt-3 grid gap-2 md:grid-cols-2">
        {!visible.length && !localError && <p className="text-sm text-muted-foreground">还没有收藏。粘贴链接、文字或拖入文件即可开始。</p>}
        {visible.map((item) => (
          <article key={item.id} className="rounded-xl border border-border bg-background p-3">
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{item.location} · {item.source}</span>
              <time>{new Date(item.createdAt).toLocaleDateString()}</time>
            </div>
            {item.url ? (
              <a href={item.url} target="_blank" rel="noopener noreferrer" className="mt-1 block text-sm font-medium text-foreground hover:underline">
                {item.title}
              </a>
            ) : <h3 className="mt-1 text-sm font-medium text-foreground">{item.title}</h3>}
            {item.summary && <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">{item.summary}</p>}
            {item.annotation && <p className="mt-2 border-l-2 border-border pl-2 text-xs text-muted-foreground">批注：{item.annotation}</p>}
            {item.tags.length > 0 && <p className="mt-2 text-xs text-muted-foreground/80">{item.tags.map((tag) => `#${tag}`).join(' ')}</p>}
          </article>
        ))}
      </div>
    </section>
  );
}
