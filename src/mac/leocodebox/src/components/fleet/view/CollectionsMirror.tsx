import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { apiClient } from '../../../utils/apiClient';

import { buildTreasuryPrompt } from './treasuryPrompt';

type RemoteItem = {
  id: string; kind: string; title: string; source_uri: string; source_label: string;
  summary: string; tags: string[]; collection_ids: string[]; created_at: number; archived: boolean; annotation: string;
  processing_state: string; processing_error_code: string; reading_state: string;
  reading_progress: number; last_opened_at: number; origin_device_id: string;
  body_available: boolean; attachment_available: boolean;
};

type LocalItem = {
  id: string; kind: string; title: string | null; source_uri: string | null;
  source_label: string; summary: string | null; snippet: string; tags: string[]; collection_ids: string[];
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

type RemoteDetail = {
  item: RemoteItem; body: string | null; status: string; stale: boolean;
};

type DisplayItem = {
  id: string; localId: string | null; remoteId: string | null; kind: string; title: string; url: string;
  source: string; summary: string; tags: string[]; createdAt: number; archived: boolean;
  annotation: string; location: 'Mac' | '手机'; processingState: string;
  processingError: string | null; readingState: string; readingProgress: number;
  lastOpenedAt: number | null;
  bodyAvailable: boolean; attachmentAvailable: boolean;
  collectionIds: string[];
};

type OfflineCollectionResult = {
  total: number; attempted: number; ready: number; pending: number;
  unavailable: number; failed: number; truncated: boolean;
};

type LibraryView = 'inbox' | 'processing' | 'failed' | 'unread' | 'recent' | 'all';
type SyncMode = 'local' | 'metadata' | 'metadata_body';
const VIEWS: Array<{ id: LibraryView; label: string; query?: string }> = [
  { id: 'inbox', label: '收件箱' },
  { id: 'processing', label: '处理中', query: 'state:saved,queued,processing' },
  { id: 'failed', label: '失败', query: 'state:partial,failed' },
  { id: 'unread', label: '待读', query: 'read:unread' },
  { id: 'recent', label: '最近使用', query: 'is:recent' },
  { id: 'all', label: '全部' },
];
const OFFLINE_COLLECTIONS_KEY = 'treasury-offline-collections-v1';
const SYNC_MODE_KEY = 'treasury-sync-mode-v1';

const loadOfflineCollections = (): string[] => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(OFFLINE_COLLECTIONS_KEY) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string' && value.length > 0).slice(0, 100)
      : [];
  } catch { return []; }
};

const loadSyncMode = (): SyncMode => {
  const stored = localStorage.getItem(SYNC_MODE_KEY);
  return stored === 'local' || stored === 'metadata_body' ? stored : 'metadata';
};

export default function CollectionsMirror({ refreshTick = 0 }: { refreshTick?: number }) {
  const [remoteItems, setRemoteItems] = useState<RemoteItem[]>([]);
  const [localItems, setLocalItems] = useState<LocalItem[]>([]);
  const [query, setQuery] = useState('');
  const [libraryView, setLibraryView] = useState<LibraryView>('inbox');
  const [selectedCollection, setSelectedCollection] = useState<string | null>(null);
  const [offlineCollections, setOfflineCollections] = useState<string[]>(loadOfflineCollections);
  const [syncMode, setSyncMode] = useState<SyncMode>(loadSyncMode);
  const [offlineStatus, setOfflineStatus] = useState<Record<string, string>>({});
  const [syncModeStatus, setSyncModeStatus] = useState<string | null>(null);
  const [captureValue, setCaptureValue] = useState('');
  const [updatedAt, setUpdatedAt] = useState(0);
  const [remoteStale, setRemoteStale] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [remoteDetail, setRemoteDetail] = useState<RemoteDetail | null>(null);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [selection, setSelection] = useState({ start: 0, end: 0, quote: '' });
  const [highlightNote, setHighlightNote] = useState('');
  const [detailBusy, setDetailBusy] = useState(false);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [attachmentStatus, setAttachmentStatus] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const detailPanel = useRef<HTMLElement>(null);
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
    if (syncMode === 'local') {
      setRemoteItems([]);
      setUpdatedAt(0);
      setRemoteStale(false);
      setRemoteError(null);
      return;
    }
    try {
      const remote = await apiClient.get<{
        items?: RemoteItem[]; updatedAt?: number; stale?: boolean; error?: { message?: string };
      }>('/api/leophone/collections');
      if (generation !== remoteGeneration.current) return;
      setRemoteItems(remote.items ?? []);
      setUpdatedAt(remote.updatedAt ?? 0);
      setRemoteStale(remote.stale === true);
      setRemoteError(remote.stale ? remote.error?.message || '手机同步内容可能已陈旧' : null);
    } catch (error) {
      if (generation === remoteGeneration.current) {
        setRemoteStale(true);
        setRemoteError(error instanceof Error ? error.message : '手机收藏同步失败');
      }
    }
  }, [syncMode]);

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

  useEffect(() => {
    if (selectedId) detailPanel.current?.focus();
  }, [selectedId]);

  const visible = useMemo<DisplayItem[]>(() => {
    const local: DisplayItem[] = localItems.map((item) => ({
      id: `local:${item.id}`, localId: item.id, remoteId: null, kind: item.kind,
      title: item.title || item.source_label, url: item.source_uri || '', source: item.source_label,
      summary: item.summary || item.snippet || '', tags: item.tags, createdAt: Date.parse(item.created_at),
      archived: item.archived, annotation: '', location: 'Mac', processingState: item.processing_state,
      processingError: item.processing_error_code, readingState: item.reading_state,
      readingProgress: item.reading_progress,
      lastOpenedAt: item.last_opened_at ? Date.parse(item.last_opened_at) : null,
      bodyAvailable: true, attachmentAvailable: false,
      collectionIds: item.collection_ids ?? [],
    }));
    const remote: DisplayItem[] = remoteItems.map((item) => ({
      id: `remote:${item.id}`, localId: null, remoteId: item.id, kind: item.kind,
      title: item.title || item.source_uri || '(无标题)', url: item.source_uri, source: item.source_label,
      summary: item.summary, tags: item.tags, createdAt: item.created_at * 1000,
      archived: Boolean(item.archived), annotation: item.annotation || '', location: '手机',
      processingState: item.processing_state, processingError: item.processing_error_code || null,
      readingState: item.reading_state, readingProgress: item.reading_progress,
      lastOpenedAt: item.last_opened_at ? item.last_opened_at * 1000 : null,
      bodyAvailable: item.body_available, attachmentAvailable: item.attachment_available,
      collectionIds: item.collection_ids ?? [],
    }));
    const terms = query.toLocaleLowerCase().split(/\s+/).filter((term) => term && !term.includes(':'));
    const matchesView = (item: DisplayItem) => {
      if (libraryView === 'inbox') return item.lastOpenedAt === null;
      if (libraryView === 'processing') return ['saved', 'queued', 'processing'].includes(item.processingState);
      if (libraryView === 'failed') return ['partial', 'failed'].includes(item.processingState);
      if (libraryView === 'unread') return item.readingState === 'unread';
      if (libraryView === 'recent') return item.lastOpenedAt !== null;
      return true;
    };
    return [...local, ...remote]
      .filter((item) => !item.archived && matchesView(item))
      .filter((item) => !selectedCollection || item.collectionIds.includes(selectedCollection))
      .filter((item) => !terms.length || terms.every((term) =>
        `${item.title} ${item.summary} ${item.source} ${item.tags.join(' ')} ${item.annotation}`
          .toLocaleLowerCase().includes(term)))
      .sort((left, right) => libraryView === 'recent'
        ? (right.lastOpenedAt ?? 0) - (left.lastOpenedAt ?? 0) : right.createdAt - left.createdAt);
  }, [libraryView, localItems, query, remoteItems, selectedCollection]);

  const collections = useMemo(() => {
    const counts = new Map<string, { total: number; remote: number }>();
    for (const item of [...localItems, ...remoteItems]) {
      for (const id of item.collection_ids ?? []) {
        const current = counts.get(id) ?? { total: 0, remote: 0 };
        current.total += 1;
        if ('origin_device_id' in item) current.remote += 1;
        counts.set(id, current);
      }
    }
    return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right, 'zh-CN'));
  }, [localItems, remoteItems]);

  const prefetchOfflineCollection = useCallback(async (collectionId: string) => {
    setOfflineStatus((current) => ({ ...current, [collectionId]: '正在准备离线正文…' }));
    try {
      const result = await apiClient.post<OfflineCollectionResult>('/api/leophone/collections/offline', {
        collection_id: collectionId,
      });
      const suffix = result.truncated ? '；本轮达到 200 条上限，将在后续刷新继续' : '';
      setOfflineStatus((current) => ({
        ...current,
        [collectionId]: `已缓存 ${result.ready}/${result.total}；等待手机 ${result.pending}，不可用 ${result.unavailable}，失败 ${result.failed}${suffix}`,
      }));
    } catch (error) {
      setOfflineStatus((current) => ({
        ...current,
        [collectionId]: error instanceof Error ? error.message : '离线正文准备失败',
      }));
    }
  }, []);

  const prefetchAllBodies = useCallback(async () => {
    setSyncModeStatus('正在准备手机正文离线缓存…');
    try {
      const result = await apiClient.post<OfflineCollectionResult>('/api/leophone/collections/offline', {
        all_body: true,
      });
      const suffix = result.truncated ? '；本轮达到 200 条上限，将在后续刷新继续' : '';
      setSyncModeStatus(
        `正文已缓存 ${result.ready}/${result.total}；等待手机 ${result.pending}，不可用 ${result.unavailable}，失败 ${result.failed}${suffix}`,
      );
    } catch (error) {
      setSyncModeStatus(error instanceof Error ? error.message : '正文离线缓存失败');
    }
  }, []);

  useEffect(() => {
    if (syncMode === 'local' || remoteStale) return;
    for (const collectionId of offlineCollections) void prefetchOfflineCollection(collectionId);
  }, [offlineCollections, prefetchOfflineCollection, remoteItems, remoteStale, syncMode]);

  useEffect(() => {
    if (syncMode !== 'metadata_body' || remoteStale || !remoteItems.length) return;
    void prefetchAllBodies();
  }, [prefetchAllBodies, remoteItems, remoteStale, syncMode, updatedAt]);

  const updateSyncMode = useCallback((mode: SyncMode) => {
    localStorage.setItem(SYNC_MODE_KEY, mode);
    setSyncMode(mode);
    if (mode === 'local' && selectedId?.startsWith('remote:')) {
      detailGeneration.current += 1;
      setSelectedId(null);
      setRemoteDetail(null);
      setDetailBusy(false);
      setAttachmentBusy(false);
      setAttachmentStatus(null);
    }
    setSyncModeStatus(mode === 'local'
      ? '已切换为仅本机；手机缓存仍保留，但不会展示或刷新。'
      : mode === 'metadata'
        ? '仅同步手机元数据；正文和附件继续按需获取。'
        : '同步手机元数据，并缓存可用正文；附件继续按需获取。');
  }, [selectedId]);

  const toggleOfflineCollection = useCallback((collectionId: string) => {
    setOfflineCollections((current) => {
      const next = current.includes(collectionId)
        ? current.filter((value) => value !== collectionId)
        : [...current, collectionId].slice(-100);
      localStorage.setItem(OFFLINE_COLLECTIONS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

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
    setRemoteDetail(null);
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

  const openRemote = useCallback(async (item: RemoteItem) => {
    const generation = ++detailGeneration.current;
    setSelectedId(`remote:${item.id}`);
    setDetail(null);
    setRemoteDetail({ item, body: null, status: item.body_available ? 'loading' : 'unavailable', stale: false });
    setDetailBusy(item.body_available);
    setAttachmentBusy(false);
    setAttachmentStatus(null);
    if (!item.body_available) return;
    try {
      const response = await apiClient.raw(
        `/api/leophone/collections/${encodeURIComponent(item.id)}/body`, { method: 'GET' },
      );
      const payload = await response.json() as {
        item?: RemoteItem; body?: string | null; status?: string; stale?: boolean;
        error?: { message?: string };
      };
      if (generation !== detailGeneration.current) return;
      if (!response.ok && response.status !== 202 && response.status !== 410) {
        throw new Error(payload.error?.message || `远端正文读取失败 (${response.status})`);
      }
      setRemoteDetail({ item: payload.item ?? item, body: payload.body ?? null,
        status: payload.status ?? (response.status === 202 ? 'pending' : 'unavailable'),
        stale: payload.stale === true });
    } catch (error) {
      if (generation === detailGeneration.current) {
        setRemoteError(error instanceof Error ? error.message : '远端正文读取失败');
        setRemoteDetail({ item, body: null, status: 'failed', stale: true });
      }
    } finally {
      if (generation === detailGeneration.current) setDetailBusy(false);
    }
  }, []);

  const openRemoteAttachment = useCallback(async (item: RemoteItem) => {
    setAttachmentBusy(true);
    setAttachmentStatus('正在请求附件…');
    try {
      const endpoint = `/api/leophone/collections/${encodeURIComponent(item.id)}/attachment`;
      const response = await apiClient.raw(`${endpoint}?status=1`, { method: 'GET' });
      const payload = await response.json().catch(() => ({})) as {
        status?: string; error?: { message?: string };
      };
      if (response.status === 202) {
        setAttachmentStatus('已请求附件，等待来源设备上线后上传。');
        return;
      }
      if (response.status === 410) {
        setAttachmentStatus('附件当前不可用；原始收藏仍然保留。');
        return;
      }
      if (!response.ok || payload.status !== 'ready') {
        throw new Error(payload.error?.message || `远端附件读取失败 (${response.status})`);
      }
      setAttachmentStatus('附件已就绪，正在打开。');
      window.open(endpoint, '_blank', 'noopener,noreferrer');
    } catch (error) {
      setAttachmentStatus(error instanceof Error ? error.message : '远端附件读取失败');
    } finally {
      setAttachmentBusy(false);
    }
  }, []);

  const sendToAgent = useCallback((text: string) => {
    window.dispatchEvent(new CustomEvent('leocodebox:launch-treasury-prompt', {
      detail: { text },
    }));
  }, []);

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
          <p className="mt-0.5 text-xs text-muted-foreground">Mac 本机优先保存；手机离线时保留最后一次成功的增量内容。</p>
        </div>
        {updatedAt > 0 && <span className="text-xs text-muted-foreground">
          手机增量 {new Date(updatedAt * 1000).toLocaleString()}{remoteStale ? ' · 陈旧' : ''}
        </span>}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/15 px-3 py-2">
        <label htmlFor="treasury-sync-mode" className="text-xs font-medium text-foreground">手机同步范围</label>
        <select id="treasury-sync-mode" value={syncMode}
          onChange={(event) => updateSyncMode(event.target.value as SyncMode)}
          className="h-9 rounded-md border border-border bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <option value="local">仅本机</option>
          <option value="metadata">同步元数据（正文/附件按需）</option>
          <option value="metadata_body">同步元数据和正文</option>
        </select>
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          附件始终按需获取；也可在合集旁单独设为离线正文。
        </p>
        {syncModeStatus && <p className="w-full text-xs text-muted-foreground" role="status">{syncModeStatus}</p>}
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

      {loading && <p className="sr-only" role="status">正在更新藏宝阁结果…</p>}
      {(remoteError || localError) && (
        <div role="alert" aria-live="assertive"
          className="mt-2 space-y-1 rounded-lg border border-warning/35 bg-warning/10 px-3 py-2 text-xs text-warning">
          {remoteError && <p>手机暂时离线，以下手机条目是上次成功内容。{remoteError}</p>}
          {localError && <p>Mac 本机藏宝阁出现错误：{localError}</p>}
        </div>
      )}

      <div className={`mt-3 grid gap-3 lg:grid-cols-[190px_minmax(0,1fr)] ${
        selectedId ? 'xl:grid-cols-[190px_minmax(0,1fr)_minmax(320px,0.8fr)]' : ''}`}>
        <nav className="rounded-xl border border-border bg-muted/15 p-2 lg:sticky lg:top-3 lg:max-h-[75vh] lg:overflow-y-auto"
          aria-label="藏宝阁智能视图与合集">
          <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">智能视图</p>
          <div className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible" role="tablist" aria-label="藏宝阁视图">
            {VIEWS.map((view, index) => (
              <button key={view.id} id={`treasury-view-${view.id}`} type="button" role="tab"
                aria-selected={libraryView === view.id} aria-controls="treasury-results"
                tabIndex={libraryView === view.id ? 0 : -1}
                onClick={() => setLibraryView(view.id)}
                onKeyDown={(event) => {
                  if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                  event.preventDefault();
                  const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? VIEWS.length - 1
                    : (index + (event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1) + VIEWS.length) % VIEWS.length;
                  const next = VIEWS[nextIndex]!;
                  setLibraryView(next.id);
                  document.getElementById(`treasury-view-${next.id}`)?.focus();
                }}
                className={`shrink-0 rounded-lg px-2.5 py-2 text-left text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  libraryView === view.id
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}>
                {view.label}
              </button>
            ))}
          </div>
          <div className="mt-3 border-t border-border pt-3">
            <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">合集</p>
            <button type="button" aria-pressed={selectedCollection === null}
              onClick={() => setSelectedCollection(null)}
              className={`w-full rounded-lg px-2.5 py-2 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                selectedCollection === null ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted'}`}>
              全部合集
            </button>
            {collections.length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground">还没有合集</p>}
            {collections.map(([collectionId, count]) => {
              const offline = offlineCollections.includes(collectionId);
              return (
                <div key={collectionId} className="mt-1 rounded-lg border border-transparent p-1 hover:border-border">
                  <button type="button" aria-pressed={selectedCollection === collectionId}
                    onClick={() => setSelectedCollection(collectionId)}
                    className={`w-full rounded-md px-2 py-1.5 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      selectedCollection === collectionId ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
                    <span className="block truncate" title={collectionId}>{collectionId}</span>
                    <span className="mt-0.5 block text-[10px] opacity-75">{count.total} 条{count.remote ? ` · 手机 ${count.remote}` : ''}</span>
                  </button>
                  {count.remote > 0 && (
                    <button type="button" aria-pressed={offline}
                      onClick={() => toggleOfflineCollection(collectionId)}
                      className="mt-1 w-full rounded-md border border-border px-2 py-1 text-left text-[10px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      {offline ? '已设为离线正文' : '设为离线正文'}
                    </button>
                  )}
                  {offline && offlineStatus[collectionId] && (
                    <p className="px-2 pt-1 text-[10px] leading-4 text-muted-foreground" role="status">
                      {offlineStatus[collectionId]}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </nav>

        <main id="treasury-results" role="tabpanel" aria-labelledby={`treasury-view-${libraryView}`}
          className="min-w-0">
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索，支持 type:link read:unread tag:工作 is:pinned"
            aria-label="搜索 Mac 与手机藏宝阁"
            className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" />
          <div className="mt-3 grid content-start gap-2 2xl:grid-cols-2">
          {!loading && !visible.length && !localError && <p className="text-sm text-muted-foreground">当前视图还没有内容。</p>}
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
              ) : (
                <button type="button"
                  onClick={() => {
                    const remote = remoteItems.find((entry) => entry.id === item.remoteId);
                    if (remote) void openRemote(remote);
                  }}
                  className="mt-1 block w-full text-left text-sm font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {item.title}
                </button>
              )}
              {item.location === '手机' && item.url && (
                <a href={item.url} target="_blank" rel="noopener noreferrer"
                  className="mt-1 inline-block text-xs text-primary hover:underline">打开来源</a>
              )}
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
        </main>

        {selectedId && (
          <aside ref={detailPanel} tabIndex={-1}
            className="rounded-xl border border-border bg-background p-4 outline-none lg:col-start-2 xl:sticky xl:top-3 xl:col-start-3 xl:row-start-1 xl:max-h-[75vh] xl:overflow-y-auto"
            aria-label="藏宝阁阅读详情" aria-busy={detailBusy}>
            <div className="flex items-start justify-between gap-3">
              <div><p className="text-xs text-muted-foreground">{remoteDetail ? '手机按需内容' : 'Mac 本机内容'}</p>
                <h3 className="text-base font-semibold text-foreground">
                  {remoteDetail?.item.title || remoteDetail?.item.source_label ||
                    detail?.item.title || detail?.item.source_label || '正在读取…'}
                </h3></div>
              <button type="button" onClick={() => {
                detailGeneration.current += 1;
                setSelectedId(null);
                setDetail(null);
                setRemoteDetail(null);
                setDetailBusy(false);
                setAttachmentBusy(false);
                setAttachmentStatus(null);
              }}
                aria-label="关闭阅读详情"
                className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">关闭</button>
            </div>
            {remoteDetail && <>
              <p className="mt-4 text-xs text-muted-foreground">
                手机按需内容{remoteDetail.stale ? ' · 当前显示上次成功缓存' : ''}
              </p>
              <div className="mt-3">
                <p className="mb-1 text-xs font-medium text-foreground">正文</p>
                {remoteDetail.body ? (
                  <textarea readOnly value={remoteDetail.body} aria-label="手机收藏正文"
                    className="min-h-56 w-full resize-y rounded-lg border border-border bg-muted/20 p-3 text-sm leading-6 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20" />
                ) : (
                  <div className="rounded-lg bg-muted/30 p-3 text-sm text-muted-foreground">
                    {remoteDetail.status === 'pending'
                      ? '已请求正文，等待来源手机上线后上传。'
                      : remoteDetail.status === 'loading' ? '正在请求正文…'
                        : '正文当前不可用；元数据和原始收藏仍然保留。'}
                  </div>
                )}
                {remoteDetail.status !== 'ready' && remoteDetail.item.body_available && (
                  <button type="button" disabled={detailBusy}
                    onClick={() => void openRemote(remoteDetail.item)}
                    className="mt-2 rounded-lg border border-border px-3 py-2 text-xs font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-45">
                    重试读取正文
                  </button>
                )}
              </div>
              {remoteDetail.item.attachment_available && (
                <div className="mt-4">
                  <button type="button" disabled={attachmentBusy}
                    onClick={() => void openRemoteAttachment(remoteDetail.item)}
                    className="rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-45">
                    {attachmentBusy ? '正在获取附件…' : '按需获取附件'}
                  </button>
                  {attachmentStatus && (
                    <p className="mt-2 text-xs text-muted-foreground" role="status">{attachmentStatus}</p>
                  )}
                </div>
              )}
              <button type="button" onClick={() => sendToAgent(buildTreasuryPrompt({
                id: remoteDetail.item.id,
                title: remoteDetail.item.title,
                kind: remoteDetail.item.kind,
                source: remoteDetail.item.source_uri || remoteDetail.item.source_label,
                summary: remoteDetail.item.summary,
                annotation: remoteDetail.item.annotation,
                tags: remoteDetail.item.tags,
                body: remoteDetail.body,
              }))}
                className="mt-3 rounded-lg border border-border px-3 py-2 text-xs font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                引用到新对话
              </button>
            </>}
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
                      <button type="button" onClick={() => {
                        if (window.confirm('确认删除这条高亮和批注？此操作无法撤销。')) void deleteHighlight(highlight.id);
                      }}
                        className="mt-2 text-warning hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">删除高亮</button>
                    </blockquote>
                  ))}
                </div>
              )}
              <button type="button" onClick={() => sendToAgent(buildTreasuryPrompt({
                id: detail.item.id,
                title: detail.item.title,
                kind: detail.item.kind,
                source: detail.item.source_uri || detail.item.source_label,
                summary: detail.item.summary,
                annotation: detail.item.annotation,
                tags: detail.item.tags,
                body: detail.body,
              }))}
                className="mt-4 rounded-lg border border-border px-3 py-2 text-xs font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                引用到新对话
              </button>
            </>}
          </aside>
        )}
      </div>
    </section>
  );
}
