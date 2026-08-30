import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { apiClient } from '../../../utils/apiClient';

type RemoteItem = {
  id: string; kind: string; title: string; url: string; source: string;
  summary: string; tags: string[]; created_at: number; archived?: boolean; annotation?: string;
};

type LocalItem = {
  id: string; kind: string; title: string | null; source_uri: string | null;
  source_label: string; summary: string | null; snippet: string; tags: string[];
  created_at: string; archived: boolean; pinned: boolean; processing_state: string;
  processing_error_code: string | null; reading_state: string; reading_progress: number;
  last_opened_at: string | null;
};

type Highlight = {
  id: string; item_id: string; quote_text: string; note: string | null;
  start_offset: number; end_offset: number; page_number: number | null;
};

type Detail = {
  item: LocalItem & { annotation?: string | null };
  body: string | null; body_status: string; truncated: boolean;
};

type DisplayItem = {
  id: string; localId: string | null; kind: string; title: string; url: string;
  source: string; summary: string; tags: string[]; createdAt: number; archived: boolean;
  annotation: string; location: 'Mac' | '手机'; processingState: string;
  processingError: string | null; readingState: string; readingProgress: number;
  lastOpenedAt: number | null;
};

type LibraryView = 'inbox' | 'processing' | 'failed' | 'unread' | 'recent' | 'all';
const VIEWS: Array<{ id: LibraryView; label: string; query?: string }> = [
  { id: 'inbox', label: '收件箱' },
  { id: 'processing', label: '处理中', query: 'state:saved,queued,processing' },
  { id: 'failed', label: '失败', query: 'state:partial,failed' },
  { id: 'unread', label: '待读', query: 'read:unread' },
  { id: 'recent', label: '最近使用', query: 'is:recent' },
  { id: 'all', label: '全部' },
];

export default function CollectionsMirror({ refreshTick = 0 }: { refreshTick?: number }) {
  const [remoteItems, setRemoteItems] = useState<RemoteItem[]>([]);
  const [localItems, setLocalItems] = useState<LocalItem[]>([]);
  const [query, setQuery] = useState('');
  const [libraryView, setLibraryView] = useState<LibraryView>('inbox');
  const [captureValue, setCaptureValue] = useState('');
  const [updatedAt, setUpdatedAt] = useState(0);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [selection, setSelection] = useState({ start: 0, end: 0, quote: '' });
  const [highlightNote, setHighlightNote] = useState('');
  const [detailBusy, setDetailBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const loadGeneration = useRef(0);
  const remoteGeneration = useRef(0);
  const detailGeneration = useRef(0);

  const serverQuery = useMemo(() => {
    const viewToken = VIEWS.find((entry) => entry.id === libraryView)?.query ?? '';
    return [query.trim(), viewToken].filter(Boolean).join(' ');
  }, [libraryView, query]);

  const loadLocal = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    const local = await Promise.resolve(
      apiClient.get<{ items?: LocalItem[] }>('/api/treasury', { q: serverQuery, limit: 200 }),
    ).then((value) => ({ status: 'fulfilled' as const, value }))
      .catch((reason: unknown) => ({ status: 'rejected' as const, reason }));
    if (generation !== loadGeneration.current) return;
    if (local.status === 'fulfilled') {
      setLocalItems(local.value.items ?? []);
      setLocalError(null);
    } else setLocalError(local.reason instanceof Error ? local.reason.message : 'Mac 藏宝阁读取失败');
    setLoading(false);
  }, [serverQuery]);

  const loadRemote = useCallback(async () => {
    const generation = ++remoteGeneration.current;
    try {
      const remote = await apiClient.get<{ items?: RemoteItem[]; updatedAt?: number }>('/api/leophone/collections');
      if (generation !== remoteGeneration.current) return;
      setRemoteItems(remote.items ?? []);
      setUpdatedAt(remote.updatedAt ?? 0);
      setRemoteError(null);
    } catch (error) {
      if (generation === remoteGeneration.current) {
        setRemoteError(error instanceof Error ? error.message : '手机收藏同步失败');
      }
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadLocal(), 180);
    return () => window.clearTimeout(timer);
  }, [loadLocal]);

  useEffect(() => { void loadRemote(); }, [loadRemote, refreshTick]);

  useEffect(() => () => {
    loadGeneration.current += 1;
    remoteGeneration.current += 1;
    detailGeneration.current += 1;
  }, []);

  const visible = useMemo<DisplayItem[]>(() => {
    const local: DisplayItem[] = localItems.map((item) => ({
      id: `local:${item.id}`, localId: item.id, kind: item.kind,
      title: item.title || item.source_label, url: item.source_uri || '', source: item.source_label,
      summary: item.summary || item.snippet || '', tags: item.tags, createdAt: Date.parse(item.created_at),
      archived: item.archived, annotation: '', location: 'Mac', processingState: item.processing_state,
      processingError: item.processing_error_code, readingState: item.reading_state,
      readingProgress: item.reading_progress,
      lastOpenedAt: item.last_opened_at ? Date.parse(item.last_opened_at) : null,
    }));
    const remote: DisplayItem[] = remoteItems.map((item) => ({
      id: `remote:${item.id}`, localId: null, kind: item.kind,
      title: item.title || item.url || '(无标题)', url: item.url, source: item.source,
      summary: item.summary, tags: item.tags, createdAt: item.created_at * 1000,
      archived: Boolean(item.archived), annotation: item.annotation || '', location: '手机',
      processingState: 'ready', processingError: null, readingState: 'none',
      readingProgress: 0, lastOpenedAt: null,
    }));
    const terms = query.toLocaleLowerCase().split(/\s+/).filter((term) => term && !term.includes(':'));
    const matchesView = (item: DisplayItem) => {
      if (item.location === '手机') return libraryView === 'inbox' || libraryView === 'all';
      if (libraryView === 'inbox') return item.lastOpenedAt === null;
      if (libraryView === 'processing') return ['saved', 'queued', 'processing'].includes(item.processingState);
      if (libraryView === 'failed') return ['partial', 'failed'].includes(item.processingState);
      if (libraryView === 'unread') return item.readingState === 'unread';
      if (libraryView === 'recent') return item.lastOpenedAt !== null;
      return true;
    };
    return [...local, ...remote]
      .filter((item) => !item.archived && matchesView(item))
      .filter((item) => !terms.length || terms.every((term) =>
        `${item.title} ${item.summary} ${item.source} ${item.tags.join(' ')} ${item.annotation}`
          .toLocaleLowerCase().includes(term)))
      .sort((left, right) => libraryView === 'recent'
        ? (right.lastOpenedAt ?? 0) - (left.lastOpenedAt ?? 0) : right.createdAt - left.createdAt);
  }, [libraryView, localItems, query, remoteItems]);

  const saveTextOrUrl = useCallback(async () => {
    const content = captureValue.trim();
    if (!content) return;
    setSaving(true);
    try {
      await apiClient.post('/api/treasury', {
        kind: /^https?:\/\/\S+$/i.test(content) ? 'link' : 'text', content,
      });
      setCaptureValue('');
      await loadLocal();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : '保存失败');
    } finally { setSaving(false); }
  }, [captureValue, loadLocal]);

  const uploadFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setSaving(true);
    const form = new FormData();
    files.slice(0, 20).forEach((file) => form.append('files', file));
    try {
      const response = await apiClient.raw('/api/treasury/files', { method: 'POST', body: form });
      await response.json();
      await loadLocal();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : '文件保存失败');
    } finally { setSaving(false); }
  }, [loadLocal]);

  const openLocal = useCallback(async (id: string) => {
    const generation = ++detailGeneration.current;
    setSelectedId(id);
    setDetailBusy(true);
    setSelection({ start: 0, end: 0, quote: '' });
    try {
      const [nextDetail, nextHighlights] = await Promise.all([
        apiClient.get<Detail>(`/api/treasury/${encodeURIComponent(id)}`, { max_chars: 100_000 }),
        apiClient.get<{ highlights: Highlight[] }>(`/api/treasury/${encodeURIComponent(id)}/highlights`),
      ]);
      if (generation !== detailGeneration.current) return;
      const state = nextDetail.item.reading_state === 'unread' ? 'reading' : nextDetail.item.reading_state;
      const updated = await apiClient.patch<{ item: LocalItem }>(
        `/api/treasury/${encodeURIComponent(id)}/reading`,
        { reading_state: state, reading_progress: nextDetail.item.reading_progress, opened: true },
      );
      if (generation !== detailGeneration.current) return;
      setDetail({ ...nextDetail, item: { ...nextDetail.item, ...updated.item } });
      setHighlights(nextHighlights.highlights);
      await loadLocal();
    } catch (error) {
      if (generation === detailGeneration.current) {
        setLocalError(error instanceof Error ? error.message : '详情读取失败');
      }
    } finally {
      if (generation === detailGeneration.current) setDetailBusy(false);
    }
  }, [loadLocal]);

  const updateReading = useCallback(async (state: string, progress: number) => {
    if (!selectedId || !detail) return;
    setDetailBusy(true);
    try {
      const response = await apiClient.patch<{ item: LocalItem }>(
        `/api/treasury/${encodeURIComponent(selectedId)}/reading`,
        { reading_state: state, reading_progress: progress, opened: true },
      );
      setDetail({ ...detail, item: { ...detail.item, ...response.item } });
      await loadLocal();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : '阅读状态保存失败');
    } finally { setDetailBusy(false); }
  }, [detail, loadLocal, selectedId]);

  const saveHighlight = useCallback(async () => {
    if (!selectedId || !selection.quote) return;
    setDetailBusy(true);
    try {
      const response = await apiClient.post<{ highlight: Highlight }>(
        `/api/treasury/${encodeURIComponent(selectedId)}/highlights`,
        { quote_text: selection.quote, note: highlightNote,
          start_offset: selection.start, end_offset: selection.end },
      );
      setHighlights((current) => [...current, response.highlight]
        .sort((left, right) => left.start_offset - right.start_offset));
      setHighlightNote('');
      setSelection({ start: 0, end: 0, quote: '' });
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : '高亮保存失败');
    } finally { setDetailBusy(false); }
  }, [highlightNote, selectedId, selection]);

  const deleteHighlight = useCallback(async (id: string) => {
    if (!selectedId) return;
    try {
      await apiClient.delete(
        `/api/treasury/${encodeURIComponent(selectedId)}/highlights/${encodeURIComponent(id)}`,
      );
      setHighlights((current) => current.filter((entry) => entry.id !== id));
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : '高亮删除失败');
    }
  }, [selectedId]);

  return (
    <section className="mt-6" aria-labelledby="treasury-heading" aria-busy={loading}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 id="treasury-heading" className="text-sm font-medium text-foreground">藏宝阁 · {visible.length}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Mac 本机优先保存；手机离线时保留最后一次成功内容。</p>
        </div>
        {updatedAt > 0 && <span className="text-xs text-muted-foreground">手机索引 {new Date(updatedAt * 1000).toLocaleString()}</span>}
      </div>

      <div className="mt-3 rounded-xl border border-dashed border-border bg-muted/25 p-3"
        role="group" aria-label="保存到 Mac 藏宝阁" aria-busy={saving}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => { event.preventDefault(); void uploadFiles(Array.from(event.dataTransfer.files)); }}>
        <div className="flex flex-col gap-2 sm:flex-row">
          <textarea value={captureValue} onChange={(event) => setCaptureValue(event.target.value)}
            placeholder="粘贴 URL 或文字，先保存，稍后再增强" aria-label="要保存的链接或文字" rows={2}
            className="min-h-16 flex-1 resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" />
          <div className="flex shrink-0 gap-2 sm:flex-col">
            <button type="button" disabled={saving || !captureValue.trim()}
              onClick={() => void saveTextOrUrl()}
              className="min-h-10 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-45">
              {saving ? '保存中…' : '收进藏宝阁'}
            </button>
            <button type="button" disabled={saving} onClick={() => fileInput.current?.click()}
              className="min-h-10 rounded-lg border border-border bg-background px-4 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-45">
              选择文件
            </button>
            <input ref={fileInput} type="file" multiple className="hidden"
              aria-label="选择要保存的文件" onChange={(event) => {
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

      <div className="mt-3 flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="藏宝阁视图">
        {VIEWS.map((view) => (
          <button key={view.id} type="button" role="tab" aria-selected={libraryView === view.id}
            onClick={() => setLibraryView(view.id)}
            className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              libraryView === view.id
                ? 'bg-primary text-primary-foreground'
                : 'border border-border bg-background text-muted-foreground hover:text-foreground'}`}>
            {view.label}
          </button>
        ))}
      </div>
      <input type="search" value={query} onChange={(event) => setQuery(event.target.value)}
        placeholder="搜索，支持 type:link read:unread tag:工作 is:pinned"
        aria-label="搜索 Mac 与手机藏宝阁"
        className="mt-2 h-9 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" />

      <div className={`mt-3 grid gap-3 ${selectedId ? 'xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]' : ''}`}>
        <div className="grid content-start gap-2 md:grid-cols-2">
          {!visible.length && !localError && <p className="text-sm text-muted-foreground">当前视图还没有内容。</p>}
          {visible.map((item) => (
            <article key={item.id} className="rounded-xl border border-border bg-background p-3">
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>{item.location} · {item.source}</span>
                <time>{new Date(item.createdAt).toLocaleDateString()}</time>
              </div>
              {item.localId ? (
                <button type="button" onClick={() => void openLocal(item.localId!)}
                  className="mt-1 block w-full text-left text-sm font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {item.title}
                </button>
              ) : item.url ? (
                <a href={item.url} target="_blank" rel="noopener noreferrer"
                  className="mt-1 block text-sm font-medium text-foreground hover:underline">{item.title}</a>
              ) : <h3 className="mt-1 text-sm font-medium text-foreground">{item.title}</h3>}
              {item.summary && <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">{item.summary}</p>}
              {item.processingError && <p className="mt-2 text-xs text-warning">处理失败：{item.processingError}</p>}
              {item.readingState !== 'none' && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {item.readingState === 'read' ? '已读' : item.readingState === 'reading' ? '阅读中' : '未读'} · {Math.round(item.readingProgress * 100)}%
                </p>
              )}
              {item.annotation && <p className="mt-2 border-l-2 border-border pl-2 text-xs text-muted-foreground">批注：{item.annotation}</p>}
              {item.tags.length > 0 && <p className="mt-2 text-xs text-muted-foreground/80">{item.tags.map((tag) => `#${tag}`).join(' ')}</p>}
            </article>
          ))}
        </div>

        {selectedId && (
          <aside className="rounded-xl border border-border bg-background p-4 xl:sticky xl:top-3 xl:max-h-[75vh] xl:overflow-y-auto"
            aria-label="藏宝阁阅读详情" aria-busy={detailBusy}>
            <div className="flex items-start justify-between gap-3">
              <div><p className="text-xs text-muted-foreground">Mac 本机内容</p>
                <h3 className="text-base font-semibold text-foreground">{detail?.item.title || detail?.item.source_label || '正在读取…'}</h3></div>
              <button type="button" onClick={() => {
                detailGeneration.current += 1;
                setSelectedId(null);
                setDetail(null);
                setDetailBusy(false);
              }}
                aria-label="关闭阅读详情"
                className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">关闭</button>
            </div>
            {detail && <>
              <div className="mt-4 grid grid-cols-3 gap-2" role="group" aria-label="阅读状态">
                {(['unread', 'reading', 'read'] as const).map((state) => (
                  <button key={state} type="button" disabled={detailBusy}
                    onClick={() => void updateReading(state, state === 'read' ? 1 : detail.item.reading_progress)}
                    className={`rounded-lg border px-2 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      detail.item.reading_state === state
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border text-muted-foreground'}`}>
                    {state === 'unread' ? '未读' : state === 'reading' ? '阅读中' : '已读'}
                  </button>
                ))}
              </div>
              <label className="mt-3 block text-xs text-muted-foreground">
                阅读进度 {Math.round(detail.item.reading_progress * 100)}%
                <input type="range" min="0" max="1" step="0.01" value={detail.item.reading_progress}
                  onChange={(event) => setDetail({ ...detail, item: { ...detail.item, reading_progress: Number(event.target.value) } })}
                  onPointerUp={(event) => void updateReading(detail.item.reading_state, Number(event.currentTarget.value))}
                  onKeyUp={(event) => {
                    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                      void updateReading(detail.item.reading_state, Number(event.currentTarget.value));
                    }
                  }} className="mt-1 w-full" />
              </label>
              <div className="mt-4"><p className="mb-1 text-xs font-medium text-foreground">正文</p>
                {detail.body ? (
                  <textarea readOnly value={detail.body} aria-label="收藏正文，可选择文字添加高亮"
                    onSelect={(event) => {
                      const target = event.currentTarget;
                      const start = target.selectionStart;
                      const end = target.selectionEnd;
                      setSelection({ start, end, quote: target.value.slice(start, end) });
                    }}
                    className="min-h-56 w-full resize-y rounded-lg border border-border bg-muted/20 p-3 text-sm leading-6 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20" />
                ) : <p className="rounded-lg bg-muted/30 p-3 text-sm text-muted-foreground">
                  {detail.body_status === 'not_extracted' ? '正文尚未抽取；原始收藏仍然保留。' : '正文当前不可用。'}
                </p>}
                {detail.truncated && <p className="mt-1 text-xs text-warning">正文过长，当前详情已截断。</p>}
              </div>
              {detail.body && (
                <div className="mt-4 rounded-lg border border-border p-3">
                  <p className="text-xs font-medium text-foreground">定位高亮</p>
                  <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">
                    {selection.quote ? `已选择：${selection.quote}` : '先在正文中选择一段文字。'}
                  </p>
                  <input value={highlightNote} onChange={(event) => setHighlightNote(event.target.value)}
                    placeholder="批注（可选）" aria-label="高亮批注"
                    className="mt-2 h-9 w-full rounded-lg border border-border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" />
                  <button type="button" disabled={!selection.quote || detailBusy}
                    onClick={() => void saveHighlight()}
                    className="mt-2 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-45">
                    保存高亮
                  </button>
                </div>
              )}
              {highlights.length > 0 && (
                <div className="mt-4 space-y-2"><p className="text-xs font-medium text-foreground">已保存高亮</p>
                  {highlights.map((highlight) => (
                    <blockquote key={highlight.id} className="rounded-lg border-l-2 border-primary bg-muted/20 p-2 text-xs text-foreground">
                      <p>{highlight.quote_text}</p>
                      {highlight.note && <p className="mt-1 text-muted-foreground">{highlight.note}</p>}
                      <button type="button" onClick={() => void deleteHighlight(highlight.id)}
                        className="mt-2 text-warning hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">删除高亮</button>
                    </blockquote>
                  ))}
                </div>
              )}
            </>}
          </aside>
        )}
      </div>
    </section>
  );
}
