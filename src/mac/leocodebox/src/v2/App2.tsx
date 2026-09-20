import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTheme } from '../contexts/ThemeContext';
import type { Project } from '../types/app';
import { api, type FleetOverview, type HarnessEvent, type LocalOverview, type ProviderInfo, type SessionSummary, type SessionTarget } from './api';
import { POLICY_LABEL, applyEvent, emptyView, lastLine, modelLabel, providerOf, relativeTime, statusDot, type FlowRow, type SessionView } from './model';
import { ChannelsPage, DevicesPage, SettingsPage, readDefaultPolicy } from './pages';
import './v2.css';

// 2.0 壳:主控(会话流水)· 设备 · 通道 · 设置 · ⌘K。
// 概念脊柱:每台机器上发生的事,是一条能在任何设备上续写的流水;需要你的地方是唯一发亮的点。

const Shell = lazy(() => import('../components/shell/view/Shell'));
const FileTree = lazy(() => import('../components/file-tree/view/FileTree'));
const BrowserUsePanel = lazy(() => import('../components/browser-use/view/BrowserUsePanel'));

type View = 'home' | 'devices' | 'channels' | 'settings';
type Filter = 'all' | 'active' | 'need' | 'err' | 'history';
type DrawerKind = 'term' | 'files' | 'diff' | 'browser' | null;
type Toast = { id: number; text: string; error: boolean };
type MenuItem = { v: string; t: string; sub?: string; dot?: string; dim?: boolean; sep?: boolean };
type MenuState = { x: number; y: number; items: MenuItem[]; onPick: (v: string) => void } | null;

type Group = { id: string; name: string; role: '本机' | '被控'; online: boolean; sessions: SessionSummary[] };

const ORDER: Record<string, number> = { waiting_for_approval: 0, running: 1, starting: 1, failed: 2, idle: 3, completed: 4, cancelled: 4, orphaned: 5 };
const HISTORY = new Set(['orphaned', 'completed', 'cancelled']);
const isLive = (s: string) => s === 'running' || s === 'starting' || s === 'waiting_for_approval' || s === 'idle';

function normalizeRemote(s: Partial<SessionSummary> & { session_id: string; status: string }): SessionSummary {
  return {
    session_id: s.session_id, harness: s.harness ?? 'pi', name: s.name ?? '', cwd: s.cwd ?? '', status: s.status,
    model: s.model ?? null, policy: s.policy ?? 'default', title: s.title ?? '', last_event: s.last_event ?? null,
    created_at: s.created_at ?? 0, updated_at: s.updated_at ?? 0, seq: s.seq ?? 0,
    waiting_for_approval: Boolean(s.waiting_for_approval), pending_approvals: s.pending_approvals ?? [],
  };
}

function useInterval(fn: () => void, ms: number): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const id = window.setInterval(() => ref.current(), ms);
    return () => window.clearInterval(id);
  }, [ms]);
}

/** 会话事件流:先回放再跟随;断了按最后 seq 续传。 */
function useSessionStream(target: SessionTarget | null, seed: SessionSummary | null): SessionView {
  const [view, setView] = useState<SessionView>(() => emptyView(seed));
  const seqRef = useRef(0);
  useEffect(() => {
    seqRef.current = 0;
    setView(emptyView(seed));
    if (!target) return undefined;
    let cancelled = false;
    let stop: (() => void) | null = null;
    let timer: number | null = null;
    const connect = () => {
      if (cancelled) return;
      stop = api.subscribe(target, seqRef.current, (event: HarnessEvent) => {
        if (typeof event.seq === 'number') seqRef.current = Math.max(seqRef.current, event.seq);
        setView((prev) => applyEvent(prev, event));
      }, () => {
        if (cancelled) return;
        timer = window.setTimeout(connect, 1500);
      });
    };
    connect();
    return () => {
      cancelled = true;
      stop?.();
      if (timer) window.clearTimeout(timer);
    };
    // seed 只用于初始化;切换会话由 target 驱动。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.machine, target?.id]);
  return view;
}

export default function App2() {
  const { isDarkMode, toggleDarkMode } = useTheme();
  const [view, setView] = useState<View>('home');
  const [filter, setFilter] = useState<Filter>('all');
  const [local, setLocal] = useState<LocalOverview | null>(null);
  const [fleet, setFleet] = useState<FleetOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [active, setActive] = useState<SessionTarget | null>(() => {
    try { const raw = localStorage.getItem('leo2.active'); return raw ? (JSON.parse(raw) as SessionTarget) : null; } catch { return null; }
  });
  const [drawer, setDrawer] = useState<DrawerKind>(null);
  const [palette, setPalette] = useState<{ open: boolean; query: string; index: number }>({ open: false, query: '', index: 0 });
  const [menu, setMenu] = useState<MenuState>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [newBox, setNewBox] = useState<{ open: boolean; machine: string } | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const flowRef = useRef<HTMLDivElement | null>(null);
  const headRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  const toast = useCallback((text: string, error = false) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, error }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), error ? 4000 : 2200);
  }, []);

  // -- 数据 ------------------------------------------------------------------
  const refreshLocal = useCallback(async () => {
    try { setLocal(await api.local()); setLoadError(null); } catch (e) { setLoadError(e instanceof Error ? e.message : String(e)); }
  }, []);
  const refreshFleet = useCallback(async () => {
    try { setFleet(await api.fleet()); } catch { /* 中继没配或不可达:只影响远程分组 */ }
  }, []);
  const refreshProviders = useCallback(async () => {
    try { setProviders((await api.providers()).providers); } catch { /* 设置页会再报 */ }
  }, []);
  useEffect(() => { void refreshLocal(); void refreshFleet(); void refreshProviders(); }, [refreshLocal, refreshFleet, refreshProviders]);
  useInterval(() => { void refreshLocal(); }, 4000);
  useInterval(() => { void refreshFleet(); }, 12000);
  useEffect(() => { try { localStorage.setItem('leo2.active', JSON.stringify(active)); } catch { /* ignore */ } }, [active]);

  const groups = useMemo<Group[]>(() => {
    const out: Group[] = [];
    if (local) out.push({ id: 'local', name: local.name, role: '本机', online: true, sessions: local.sessions });
    for (const m of fleet?.machines ?? []) {
      if (local && (m.name === local.name || m.name === fleet?.localName)) continue;
      out.push({ id: m.name, name: m.name, role: '被控', online: m.online && m.reachable, sessions: m.sessions.map(normalizeRemote) });
    }
    return out;
  }, [local, fleet]);

  const allSessions = useMemo(() => groups.flatMap((g) => g.sessions.map((s) => ({ machine: g.id, machineName: g.name, s }))), [groups]);
  const activeEntry = useMemo(() => allSessions.find((x) => active && x.machine === active.machine && x.s.session_id === active.id) ?? null, [allSessions, active]);
  const activeSummary = activeEntry?.s ?? null;
  const sessionView = useSessionStream(active, activeSummary);

  const counts = useMemo(() => {
    const live = allSessions.filter((x) => !HISTORY.has(x.s.status));
    return {
      all: live.length,
      active: live.filter((x) => x.s.status === 'running' || x.s.status === 'starting' || x.s.status === 'waiting_for_approval').length,
      need: live.filter((x) => x.s.status === 'waiting_for_approval').length,
      err: live.filter((x) => x.s.status === 'failed').length,
      history: allSessions.filter((x) => HISTORY.has(x.s.status)).length,
    };
  }, [allSessions]);

  const matchesFilter = useCallback((s: SessionSummary) => {
    switch (filter) {
      case 'all': return !HISTORY.has(s.status);
      case 'active': return s.status === 'running' || s.status === 'starting' || s.status === 'waiting_for_approval';
      case 'need': return s.status === 'waiting_for_approval';
      case 'err': return s.status === 'failed';
      case 'history': return HISTORY.has(s.status);
      default: return true;
    }
  }, [filter]);

  const othersNeedingYou = useMemo(() => allSessions.filter((x) => x.s.status === 'waiting_for_approval' && !(active && x.machine === active.machine && x.s.session_id === active.id)), [allSessions, active]);

  // 首次进来没有选中会话:挑一条最需要看的。
  useEffect(() => {
    if (active || allSessions.length === 0) return;
    const pick = [...allSessions].sort((a, b) => (ORDER[a.s.status] ?? 9) - (ORDER[b.s.status] ?? 9) || b.s.updated_at - a.s.updated_at)[0];
    if (pick) setActive({ machine: pick.machine, id: pick.s.session_id });
  }, [active, allSessions]);

  // 头与输入区是悬浮玻璃,流水的内边距跟着它们的实际高度走。
  const layoutFlow = useCallback(() => {
    const flow = flowRef.current; if (!flow) return;
    flow.style.paddingTop = `${(headRef.current?.offsetHeight ?? 56) + 16}px`;
    flow.style.paddingBottom = `${(composerRef.current?.offsetHeight ?? 90) + 8}px`;
  }, []);
  useEffect(() => { layoutFlow(); window.addEventListener('resize', layoutFlow); return () => window.removeEventListener('resize', layoutFlow); }, [layoutFlow, view, othersNeedingYou.length, sessionView.rows.length]);
  const stickBottomRef = useRef(true);
  useEffect(() => {
    const flow = flowRef.current; if (!flow || !stickBottomRef.current) return;
    flow.scrollTop = flow.scrollHeight;
  }, [sessionView.rows, view]);

  // -- 动作 ------------------------------------------------------------------
  const openSession = useCallback((target: SessionTarget) => { setActive(target); setView('home'); }, []);
  const withBusy = useCallback(async (fn: () => Promise<unknown>, okText?: string) => {
    setBusy(true);
    try { await fn(); if (okText) toast(okText); await refreshLocal(); }
    catch (e) { toast(e instanceof Error ? e.message : String(e), true); }
    finally { setBusy(false); }
  }, [toast, refreshLocal]);

  const send = useCallback(async () => {
    if (!active) return;
    const text = draft.trim(); if (!text) return;
    setDraft('');
    await withBusy(() => api.send(active, text));
  }, [active, draft, withBusy]);
  const stop = useCallback(() => active && withBusy(() => api.stop(active), '已停止'), [active, withBusy]);
  const approve = useCallback((approvalId: string, choice: string) => active && withBusy(() => api.approve(active, approvalId, choice)), [active, withBusy]);
  const setPolicy = useCallback((policy: string) => active && withBusy(() => api.setPolicy(active, policy)), [active, withBusy]);
  const setModel = useCallback((provider: string, modelId: string) => active && withBusy(() => api.rpc(active, { type: 'set_model', provider, modelId })), [active, withBusy]);
  const compact = useCallback(() => active && withBusy(() => api.rpc(active, { type: 'compact' }), '压缩请求已发出'), [active, withBusy]);
  const approveFirstPending = useCallback(() => {
    const first = sessionView.pendingApprovals.values().next().value as (FlowRow & { k: 'ap' }) | undefined;
    if (first) void approve(first.approvalId, 'once');
    else if (othersNeedingYou[0]) openSession({ machine: othersNeedingYou[0].machine, id: othersNeedingYou[0].s.session_id });
    else toast('没有待批');
  }, [sessionView.pendingApprovals, othersNeedingYou, approve, openSession, toast]);

  const createSession = useCallback(async (input: { machine: string; cwd: string; prompt: string; model: string | null; policy: string }) => {
    await withBusy(async () => {
      if (input.machine === 'local') {
        const created = await api.createLocalSession({ cwd: input.cwd, prompt: input.prompt, model: input.model, policy: input.policy });
        setActive({ machine: 'local', id: created.session_id });
      } else {
        const created = await api.createRemoteSession({ machine: input.machine, cwd: input.cwd, prompt: input.prompt, model: input.model, policy: input.policy });
        await refreshFleet();
        setActive({ machine: input.machine, id: created.session_id });
      }
      setNewBox(null); setView('home');
    });
  }, [withBusy, refreshFleet]);

  // -- 菜单 ------------------------------------------------------------------
  const openMenu = useCallback((el: HTMLElement, items: MenuItem[], onPick: (v: string) => void) => {
    const r = el.getBoundingClientRect();
    setMenu({ x: Math.min(r.left, window.innerWidth - 270), y: r.bottom + 6, items, onPick });
  }, []);
  useEffect(() => {
    if (!menu) return undefined;
    const close = () => setMenu(null);
    const id = window.setTimeout(() => document.addEventListener('click', close, { once: true }), 0);
    return () => { window.clearTimeout(id); document.removeEventListener('click', close); };
  }, [menu]);

  const configuredModels = useMemo(() => providers.filter((p) => p.configured).flatMap((p) => p.models.map((m) => ({ provider: p.id, providerName: p.name, id: m.id, name: m.name }))), [providers]);

  const modelMenu = (el: HTMLElement) => {
    const items: MenuItem[] = configuredModels.length
      ? configuredModels.map((m) => ({ v: `${m.provider}/${m.id}`, t: m.name, sub: m.providerName, dot: sessionView.model === `${m.provider}/${m.id}` ? 'ok' : '' }))
      : [{ v: '', t: '还没有可用模型', sub: '去设置里添加密钥', dim: true }];
    openMenu(el, items, (v) => { if (!v) { setView('settings'); return; } const i = v.indexOf('/'); void setModel(v.slice(0, i), v.slice(i + 1)); });
  };
  const policyMenu = (el: HTMLElement) => openMenu(el, (['default', 'accept_edits', 'plan', 'auto'] as const).map((p) => ({ v: p, t: POLICY_LABEL[p], dot: sessionView.policy === p ? 'ok' : '' })), (v) => void setPolicy(v));
  const moreMenu = (el: HTMLElement) => openMenu(el, [
    { v: 'term', t: '终端', sub: '⌘T' }, { v: 'files', t: '文件', sub: '⌘E' }, { v: 'diff', t: '本次改动', sub: '⌘D' }, { v: 'browser', t: '浏览器', sub: '⌘B' },
    { v: '', t: '', sep: true },
    { v: 'compact', t: '压缩这条会话', sub: 'pi compact' }, { v: 'stop', t: '停止', sub: '进程组一起收' },
  ], (v) => { if (v === 'compact') void compact(); else if (v === 'stop') void stop(); else if (v) setDrawer(v as DrawerKind); });

  // -- 键盘 ------------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => ({ open: !p.open, query: '', index: 0 })); return; }
      if (palette.open) return;
      if (e.key === 'Escape') { if (menu) { setMenu(null); return; } if (drawer) { setDrawer(null); return; } if (newBox) { setNewBox(null); return; } return; }
      if (meta && e.key === 'Enter') {
        const ta = taRef.current;
        if (document.activeElement === ta && (draft.trim())) { e.preventDefault(); void send(); return; }
        if (document.activeElement !== ta) { e.preventDefault(); approveFirstPending(); }
        return;
      }
      if (meta && ['1', '2', '3'].includes(e.key)) { e.preventDefault(); setView((['home', 'devices', 'channels'] as View[])[Number(e.key) - 1]); return; }
      if (meta && e.key === ',') { e.preventDefault(); setView('settings'); return; }
      if (meta && e.key.toLowerCase() === 'n') { e.preventDefault(); setNewBox({ open: true, machine: 'local' }); setView('home'); return; }
      if (meta && view === 'home' && ['t', 'd', 'e', 'b'].includes(e.key.toLowerCase())) { e.preventDefault(); setDrawer(({ t: 'term', d: 'diff', e: 'files', b: 'browser' } as Record<string, DrawerKind>)[e.key.toLowerCase()]); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [palette.open, menu, drawer, newBox, draft, send, approveFirstPending, view]);

  // -- 命令面板 ---------------------------------------------------------------
  type Command = { g: string; t: string; k: string; run: () => void };
  const commands = useMemo<Command[]>(() => [
    { g: '会话', t: '新会话…', k: '⌘N', run: () => { setNewBox({ open: true, machine: 'local' }); setView('home'); } },
    ...groups.filter((g) => g.online && g.id !== 'local').map((g) => ({ g: '会话', t: `在 ${g.name} 上新会话`, k: g.role, run: () => { setNewBox({ open: true, machine: g.id }); setView('home'); } })),
    { g: '审批', t: '批准最近一条待批', k: '⌘↩', run: approveFirstPending },
    ...configuredModels.map((m) => ({ g: '模型', t: `切换模型:${m.name}`, k: m.providerName, run: () => void setModel(m.provider, m.id) })),
    ...(['default', 'accept_edits', 'plan', 'auto'] as const).map((p) => ({ g: '审批策略', t: POLICY_LABEL[p], k: '本会话', run: () => void setPolicy(p) })),
    { g: '这条会话', t: '压缩这条会话', k: 'pi compact', run: () => void compact() },
    { g: '这条会话', t: '停止', k: '', run: () => void stop() },
    { g: '这条会话', t: '终端', k: '⌘T', run: () => setDrawer('term') }, { g: '这条会话', t: '文件', k: '⌘E', run: () => setDrawer('files') },
    { g: '这条会话', t: '本次改动', k: '⌘D', run: () => setDrawer('diff') }, { g: '这条会话', t: '浏览器', k: '⌘B', run: () => setDrawer('browser') },
    { g: '页面', t: '主控', k: '⌘1', run: () => setView('home') }, { g: '页面', t: '设备', k: '⌘2', run: () => setView('devices') }, { g: '页面', t: '通道', k: '⌘3', run: () => setView('channels') }, { g: '页面', t: '设置', k: '⌘,', run: () => setView('settings') },
    { g: '外观', t: isDarkMode ? '切到亮色' : '切到暗色', k: '', run: toggleDarkMode },
    ...allSessions.map((x) => ({ g: '跳转', t: `会话:${x.s.title || x.s.session_id}`, k: x.machineName, run: () => openSession({ machine: x.machine, id: x.s.session_id }) })),
  ], [groups, configuredModels, allSessions, approveFirstPending, setModel, setPolicy, compact, stop, isDarkMode, toggleDarkMode, openSession]);
  const filteredCommands = useMemo(() => {
    const q = palette.query.trim().toLowerCase();
    return q ? commands.filter((c) => `${c.t} ${c.k} ${c.g}`.toLowerCase().includes(q)) : commands;
  }, [commands, palette.query]);
  const runCommand = (index: number) => { const c = filteredCommands[index]; setPalette({ open: false, query: '', index: 0 }); c?.run(); };

  // -- 渲染 ------------------------------------------------------------------
  const activeGroup = active ? groups.find((g) => g.id === active.machine) ?? null : null;
  const title = sessionView.title || activeSummary?.title || (activeSummary ? '新会话' : '');
  const cwd = activeSummary?.cwd ?? '';
  const project: Project | null = activeSummary ? { projectId: `harness-${activeSummary.session_id}`, displayName: title || activeSummary.session_id, fullPath: cwd, path: cwd } : null;
  const editRows = sessionView.rows.filter((r): r is FlowRow & { k: 'edit' } => r.k === 'edit');
  const canDrive = activeSummary ? isLive(activeSummary.status) || isLive(sessionView.status) : false;

  return (
    <div className={`leo2 ${isDarkMode ? '' : 'light'}`}>
      {/* 顶条:窗口隐藏标题栏下,BrowserView 顶部 ~42px 收不到真实鼠标事件(实测),
          所以这里只放"看"的东西:标题 + 状态。所有能点的都在左栏。 */}
      <header className="titlebar glass">
        <div />
        <div className="tb-title">
          {view === 'home'
            ? (activeSummary ? <><b>{title || '新会话'}</b><span className="tb-sub mono">{activeGroup?.name ?? active?.machine} · {cwd}</span></> : <b>主控</b>)
            : <b>{{ devices: '设备', channels: '通道', settings: '设置' }[view]}</b>}
        </div>
        <div className="tb-right">
          <span className="tb-status"><span className={`dot ${loadError ? 'err' : 'ok'}`} /><span>{loadError ? `本机服务:${loadError}` : `本机服务正常${fleet?.configured ? ` · 远程 ${groups.filter((g) => g.id !== 'local' && g.online).length} 台在线` : ''}`}</span></span>
        </div>
      </header>

      <div className="body">
        {(
          <aside className="rail" aria-label="会话">
            <div className="rail-top">
              <nav className="topnav" aria-label="主导航">
                {([['home', '主控', '⌘1'], ['devices', '设备', '⌘2'], ['channels', '通道', '⌘3'], ['settings', '设置', '⌘,']] as Array<[View, string, string]>).map(([v, label, k]) => (
                  <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)} title={k}>{label}</button>
                ))}
              </nav>
              <button className="btn-new" onClick={() => { void refreshProviders(); setNewBox((b) => (b?.open ? null : { open: true, machine: 'local' })); }}><span>+ 新会话</span><kbd>⌘N</kbd></button>
              <div className="chips">
                {([['all', '全部'], ['active', '进行中'], ['need', '需要你'], ['err', '失败'], ['history', '历史']] as Array<[Filter, string]>).map(([f, label]) => (
                  <button key={f} className={`chip-f ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>{label}<i>{counts[f]}</i></button>
                ))}
              </div>
            </div>
            <div className="rail-list">
              {newBox?.open && (
                <NewSessionBox machine={newBox.machine} groups={groups} models={configuredModels} defaultCwd={activeSummary?.cwd || local?.home || '~'} busy={busy}
                  onCancel={() => setNewBox(null)} onCreate={(input) => void createSession(input)} onOpenSettings={() => { setNewBox(null); setView('settings'); }} />
              )}
              {(() => {
                const visible = groups.map((g) => ({ g, ss: g.sessions.filter(matchesFilter).sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || b.updated_at - a.updated_at) })).filter((x) => x.ss.length > 0);
                if (!local && !loadError) return <div className="rail-empty">连接本机服务…</div>;
                if (visible.length === 0) return <div className="rail-empty">{filter === 'all' ? '还没有会话 —— 点上面「+ 新会话」开始' : `没有${({ active: '进行中', need: '需要你', err: '失败', history: '历史' } as Record<string, string>)[filter]}的会话`}</div>;
                return visible.map(({ g, ss }) => (
                  <div key={g.id}>
                    <div className="grp-h"><span className={`dot ${g.online ? 'ok' : 'off'}`} /><b title={g.name}>{g.name}</b><span className="role">{g.role}</span><span className="cnt">{ss.length}</span></div>
                    {ss.map((s) => {
                      const on = active?.machine === g.id && active.id === s.session_id;
                      const dot = statusDot(s.status);
                      return (
                        <button key={s.session_id} className={`srow ${on ? 'on' : ''}`} onClick={() => openSession({ machine: g.id, id: s.session_id })}>
                          <span className={`dot ${dot === 'idle' ? '' : dot}`} />
                          <div style={{ minWidth: 0 }}>
                            <div className="srow-t"><span>{s.title || '新会话'}</span><span className="srow-m">{modelLabel(s.model)}</span></div>
                            <div className={`srow-l ${dot === 'need' ? 'need' : dot === 'err' ? 'err' : ''}`}>{lastLine(s)}</div>
                          </div>
                          <span className="srow-time">{relativeTime(s.updated_at)}</span>
                        </button>
                      );
                    })}
                  </div>
                ));
              })()}
            </div>
            <div className="rail-foot">
              <button className="tb-btn" onClick={() => setPalette({ open: true, query: '', index: 0 })} title="命令面板">⌘K 命令</button>
              <button className="tb-btn" onClick={toggleDarkMode} title="切换明暗">{isDarkMode ? '亮色' : '暗色'}</button>
            </div>
          </aside>
        )}

        <main className={`main ${drawer ? 'dim' : ''}`}>
          {view === 'home' && (!activeSummary ? (
            <div className="empty-main"><b>{loadError ? '连不上本机服务' : '还没有会话'}</b><span>{loadError ? loadError : '⌘N 新建一条,或在左栏选一条继续'}</span></div>
          ) : (
            <div className="sess">
              <div className="shead-wrap" ref={headRef}>
                <header className="shead glass">
                  <div className="shead-l">
                    <span className={`dot ${statusDot(sessionView.status) === 'idle' ? '' : statusDot(sessionView.status)}`} />
                    <span className="shead-state">{({ running: '进行中', starting: '启动中', waiting_for_approval: '需要你', idle: '空闲,可以接着说', completed: '已完成', failed: '失败', cancelled: '已停止', orphaned: '已失联' } as Record<string, string>)[sessionView.status] ?? sessionView.status}</span>
                  </div>
                  <div className="shead-r">
                    <button className="chip" onClick={(e) => { e.stopPropagation(); modelMenu(e.currentTarget); }} disabled={!canDrive || activeSummary.harness !== 'pi'}><b>{modelLabel(sessionView.model)}</b>{providerOf(sessionView.model) ? <span className="car">▼</span> : null}</button>
                    <button className="chip" onClick={(e) => { e.stopPropagation(); policyMenu(e.currentTarget); }} disabled={!canDrive}>审批 <b>{POLICY_LABEL[sessionView.policy] ?? sessionView.policy}</b><span className="car">▼</span></button>
                    <button className="chip" onClick={(e) => { e.stopPropagation(); moreMenu(e.currentTarget); }}>⋯</button>
                  </div>
                </header>
                {othersNeedingYou.length > 0 && (() => {
                  const first = othersNeedingYou[0];
                  const cmd = first.s.pending_approvals?.[0]?.command ?? first.s.last_event?.text ?? '';
                  return (
                    <div className="need-strip glass">
                      <span className="cnt">需要你 · {othersNeedingYou.length}</span>
                      <span className="it">{first.s.title || '会话'} —— 在 {first.machineName} 上执行 <code>{cmd.split('\n')[0]}</code></span>
                      <button className="go" onClick={() => openSession({ machine: first.machine, id: first.s.session_id })}>去处理 →</button>
                    </div>
                  );
                })()}
              </div>
              <div className="flow" ref={flowRef} onScroll={(e) => { const el = e.currentTarget; stickBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
                <div className="flow-in">
                  {sessionView.rows.length === 0 && <div className="fc sys" style={{ padding: '8px 0' }}>{activeSummary.status === 'orphaned' ? '这是上次运行留下的记录,进程已不在;要继续请新建会话。' : '等待事件…'}</div>}
                  {sessionView.rows.map((row) => <Row key={row.key} row={row} model={sessionView.model} onApprove={approve} onDiff={() => setDrawer('diff')} />)}
                </div>
              </div>
              <div className="composer-wrap" ref={composerRef}>
                <div className="composer">
                  <textarea ref={taRef} rows={1} value={draft} disabled={!canDrive} placeholder={canDrive ? '对这条会话说点什么… ⌘↩ 发送,⇧↩ 换行' : '这条会话已经结束,不能续写'}
                    onChange={(e) => { setDraft(e.target.value); const ta = e.target; ta.style.height = 'auto'; ta.style.height = `${Math.min(180, ta.scrollHeight)}px`; layoutFlow(); }} />
                  <div className="composer-bar">
                    <button className="cb" onClick={() => toast('附件:下一步接入')}>+ 附件</button>
                    <button className="cb" onClick={() => toast('语音追问:下一步接入')}>语音</button>
                    <span className="cb info">{activeGroup?.name ?? ''} · {modelLabel(sessionView.model)} · {POLICY_LABEL[sessionView.policy] ?? sessionView.policy}</span>
                    {sessionView.status === 'running' || sessionView.status === 'starting'
                      ? <button className="btn-s stop" onClick={() => void stop()} disabled={busy}>停止</button>
                      : <button className="btn-s" onClick={() => void send()} disabled={busy || !canDrive || !draft.trim()}>发送</button>}
                  </div>
                </div>
              </div>
            </div>
          ))}
          {view === 'devices' && <DevicesPage local={local} fleet={fleet} toast={toast} onNewOn={(m) => { setNewBox({ open: true, machine: m }); setView('home'); }} />}
          {view === 'channels' && <ChannelsPage toast={toast} models={configuredModels} />}
          {view === 'settings' && <SettingsPage toast={toast} onProvidersChanged={() => void refreshProviders()} />}
        </main>
      </div>

      <aside className={`drawer ${drawer ? 'open' : ''}`} aria-hidden={!drawer}>
        <header><span>{{ term: '终端', files: '文件', diff: '本次改动', browser: '浏览器' }[drawer ?? 'term']}{activeGroup ? ` · ${activeGroup.name}` : ''}</span><button className="link" onClick={() => setDrawer(null)}>关闭<kbd>Esc</kbd></button></header>
        <div className={`drawer-body ${drawer === 'diff' ? 'pad' : ''}`}>
          {drawer && (active?.machine !== 'local' && drawer !== 'diff') ? (
            <div style={{ padding: 16, color: 'var(--fg3)' }}>远程机器的终端 / 文件在这一版还没接;先在那台机器上开。</div>
          ) : drawer === 'diff' ? (
            editRows.length === 0 ? <div style={{ color: 'var(--fg3)' }}>这条会话还没有改动文件。</div> : editRows.map((r) => (
              <div key={r.key}><div className="dl h">{r.tool} · {r.file}{r.error ? ' · 失败' : ''}</div><div className="dl">{r.output || (r.running ? '进行中…' : '(无输出)')}</div></div>
            ))
          ) : drawer && project ? (
            <div className="drawer-host"><Suspense fallback={<div style={{ padding: 16, color: 'var(--fg3)' }}>加载中…</div>}>
              {drawer === 'term' && <Shell selectedProject={project} isPlainShell autoConnect isActive minimal />}
              {drawer === 'files' && <FileTree selectedProject={project} />}
              {drawer === 'browser' && <BrowserUsePanel isVisible />}
            </Suspense></div>
          ) : null}
        </div>
      </aside>

      {palette.open && (
        <div className="palette" role="dialog" aria-label="命令面板" onClick={(e) => { if (e.target === e.currentTarget) setPalette({ open: false, query: '', index: 0 }); }}>
          <div className="pbox">
            <input autoFocus placeholder="命令、会话或设备…  ↑↓ 选择  ↩ 执行" value={palette.query}
              onChange={(e) => setPalette((p) => ({ ...p, query: e.target.value, index: 0 }))}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setPalette((p) => ({ ...p, index: Math.min(filteredCommands.length - 1, p.index + 1) })); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setPalette((p) => ({ ...p, index: Math.max(0, p.index - 1) })); }
                else if (e.key === 'Enter') { e.preventDefault(); runCommand(palette.index); }
                else if (e.key === 'Escape') { setPalette({ open: false, query: '', index: 0 }); }
              }} />
            <div className="plist">
              {filteredCommands.length === 0 && <div className="pempty">没有匹配的命令</div>}
              {filteredCommands.map((c, i) => (
                <div key={`${c.g}-${c.t}-${i}`}>
                  {(i === 0 || filteredCommands[i - 1].g !== c.g) && <div className="psec">{c.g}</div>}
                  <button className={`pli ${i === palette.index ? 'on' : ''}`} onMouseEnter={() => setPalette((p) => ({ ...p, index: i }))} onClick={() => runCommand(i)}><span>{c.t}</span><span className="k">{c.k}</span></button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {menu && (
        <div className="menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          {menu.items.map((it, i) => it.sep ? <div className="msep" key={`sep-${i}`} /> : (
            <button key={`${it.v}-${i}`} className={`mi ${it.dim ? 'dim' : ''}`} onClick={() => { menu.onPick(it.v); setMenu(null); }}>
              <span className={`dot ${it.dot ?? ''}`} style={{ visibility: it.dot === undefined ? 'hidden' : 'visible' }} /><span>{it.t}</span><span className="sub">{it.sub ?? ''}</span>
            </button>
          ))}
        </div>
      )}

      {toasts.map((t) => <div key={t.id} className={`toast ${t.error ? 'error' : ''}`}>{t.text}</div>)}
    </div>
  );
}

function Row({ row, model, onApprove, onDiff }: { row: FlowRow; model: string | null; onApprove: (id: string, choice: string) => unknown; onDiff: () => void }) {
  const [open, setOpen] = useState(false);
  switch (row.k) {
    case 'user': return <div className="frow frow-user"><div className="fl">你</div><div className="fc">{row.text}</div></div>;
    case 'ai': return <div className="frow frow-ai"><div className="fl">{modelLabel(model).split(' ')[0] || '模型'}</div><div className={`fc ${row.streaming ? 'streaming' : ''}`}>{row.text}</div></div>;
    case 'tool': return (
      <div className="frow frow-tool"><div className="fl">$</div><div className="fc">
        <div className="tool-line"><code>{row.preview || row.tool}</code>
          {row.running ? <><span className="prog" /><span className="tool-meta run">运行中</span></> : <span className={`tool-meta ${row.error ? 'err' : ''}`}>{row.error ? '失败' : '完成'}</span>}
          {row.output ? <button className="tool-toggle" onClick={() => setOpen((o) => !o)}>{open ? '收起' : '展开'}</button> : null}
        </div>
        {open && row.output ? <pre className="tool-out">{row.output}</pre> : null}
      </div></div>
    );
    case 'edit': return (
      <div className="frow frow-edit"><div className="fl">{row.tool === 'write' ? '写入' : '编辑'}</div><div className="fc">
        <div className="tool-line"><button className="tool-line" onClick={onDiff} style={{ gap: 10 }}><code>{row.file}</code>{row.running ? <span className="tool-meta run">进行中</span> : <span className={`tool-meta ${row.error ? 'err' : ''}`}>{row.error ? '失败' : '已改'}</span>}</button></div>
      </div></div>
    );
    case 'ap': return (
      <div className="frow frow-ap"><div className="fl">需要确认</div><div className="fc">
        <p>{row.title || `要在 ${row.host || '这台机器'} 上执行`}{row.tool ? ` · ${row.tool}` : ''}</p>
        <code className="cmd">{row.command}</code>
        <div className="ap-actions">
          {row.choices.includes('once') && <button className="btn-p" onClick={() => onApprove(row.approvalId, 'once')}>批准一次<kbd>⌘↩</kbd></button>}
          {row.choices.includes('session') && <button className="btn" onClick={() => onApprove(row.approvalId, 'session')}>本会话允许</button>}
          {row.choices.includes('always') && <button className="btn" onClick={() => onApprove(row.approvalId, 'always')}>总是允许</button>}
          {row.choices.filter((c) => !['once', 'session', 'always', 'deny'].includes(c)).map((c) => <button key={c} className="btn" onClick={() => onApprove(row.approvalId, c)}>{c}</button>)}
          {row.choices.includes('deny') && <button className="btn-g" onClick={() => onApprove(row.approvalId, 'deny')}>拒绝</button>}
        </div>
        <div className="ap-meta"><b>绑定:</b>{row.host || '本机'} + 这条完整命令,改一个字都要重新批准 · <b>同一张卡</b>已推到手机,任一端处理即可{row.cwd ? ` · ${row.cwd}` : ''}</div>
      </div></div>
    );
    case 'sys': return <div className="frow"><div className="fl" /><div className={`fc sys ${row.tone === 'remote' ? 'remote' : row.tone === 'error' ? 'error' : ''}`}>{row.text}</div></div>;
    default: return null;
  }
}

function NewSessionBox({ machine, groups, models, defaultCwd, busy, onCancel, onCreate, onOpenSettings }: {
  machine: string; groups: Group[]; models: Array<{ provider: string; providerName: string; id: string; name: string }>; defaultCwd: string; busy: boolean;
  onCancel: () => void; onCreate: (input: { machine: string; cwd: string; prompt: string; model: string | null; policy: string }) => void; onOpenSettings: () => void;
}) {
  const [target, setTarget] = useState(machine);
  const [cwd, setCwd] = useState(defaultCwd);
  const [model, setModel] = useState<string>(models[0] ? `${models[0].provider}/${models[0].id}` : '');
  const [policy, setPolicy] = useState(readDefaultPolicy());
  const [prompt, setPrompt] = useState('');
  useEffect(() => { setTarget(machine); }, [machine]);
  useEffect(() => { if (!model && models[0]) setModel(`${models[0].provider}/${models[0].id}`); }, [models, model]);
  // 本机会话跑的是自带的 pi 内核,没登录任何模型就开会话只会换来一句 "No API key"。
  const needModel = target === 'local' && models.length === 0;
  const submit = () => { if (!prompt.trim() || needModel) return; onCreate({ machine: target, cwd: cwd.trim() || '~', prompt: prompt.trim(), model: model || null, policy }); };
  return (
    <div className="newbox">
      {needModel && <div className="newbox-warn"><b>还没有可用的模型。</b>先到「设置」登录一个供应商或粘贴密钥,再回来开会话。<button className="btn-s" onClick={onOpenSettings}>去设置</button></div>}
      <div className="row2">
        <div><label>机器</label><select value={target} onChange={(e) => setTarget(e.target.value)}>{groups.filter((g) => g.online).map((g) => <option key={g.id} value={g.id}>{g.name}{g.id === 'local' ? '(本机)' : ''}</option>)}</select></div>
        <div><label>审批</label><select value={policy} onChange={(e) => setPolicy(e.target.value)}>{(['default', 'accept_edits', 'plan', 'auto'] as const).map((p) => <option key={p} value={p}>{POLICY_LABEL[p]}</option>)}</select></div>
      </div>
      <div><label>模型</label><select value={model} onChange={(e) => setModel(e.target.value)}>
        {target !== 'local' && <option value="">由那台机器决定</option>}
        {models.map((m) => <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>{m.name} · {m.providerName}</option>)}
      </select></div>
      <div><label>目录</label><input value={cwd} onChange={(e) => setCwd(e.target.value)} className="mono" placeholder="~/项目路径" /></div>
      <div><label>第一句话</label><textarea autoFocus value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="要它做什么" onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit(); }} /></div>
      <div className="acts"><button className="btn-g" onClick={onCancel}>取消</button><button className="btn-s" onClick={submit} disabled={busy || !prompt.trim() || needModel}>开始</button></div>
    </div>
  );
}
