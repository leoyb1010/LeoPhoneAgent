import { Suspense, lazy, useEffect, useRef, useState } from 'react';

import { api, getJson, sendJson, type FleetOverview, type LocalOverview, type ProviderInfo } from './api';
import { POLICY_LABEL } from './model';
import { LEO_RELEASE_NOTES } from '../components/version-upgrade/releaseNotes';

const LegacySettings = lazy(() => import('../components/settings/view/SettingsHost'));

export const DEFAULT_POLICY_KEY = 'leo2.defaultPolicy';

export function readDefaultPolicy(): string {
  try { return localStorage.getItem(DEFAULT_POLICY_KEY) || 'default'; } catch { return 'default'; }
}

// ---------------------------------------------------------------- 设备

export function DevicesPage({ local, fleet, onNewOn, toast }: {
  local: LocalOverview | null; fleet: FleetOverview | null;
  onNewOn: (machine: string) => void; toast: (text: string, error?: boolean) => void;
}) {
  const [joinToken, setJoinToken] = useState<string | null>(null);
  const localSessions = local?.sessions ?? [];
  const running = localSessions.filter((s) => s.status === 'running' || s.status === 'waiting_for_approval').length;
  const remote = (fleet?.machines ?? []).filter((m) => m.name !== local?.name && m.name !== fleet?.localName);
  const online = 1 + remote.filter((m) => m.online && m.reachable).length;

  const mintToken = async () => {
    try {
      const result = await sendJson<{ token?: string; join_token?: string }>('/api/leophone/join-token', {});
      setJoinToken(String(result.token ?? result.join_token ?? JSON.stringify(result)));
    } catch (error) {
      toast(error instanceof Error ? error.message : '生成配对码失败', true);
    }
  };

  return (
    <section className="page"><div className="page-in">
      <div className="page-h"><h1>设备</h1><span className="meta">{1 + remote.length} 台 · {online} 在线</span></div>
      <p className="lead">一行一台。本机既能被手机控制,也能控制其他被控机器;会话跑在哪台机器上,就在左栏归到哪一组。</p>
      <div className="trow h"><span /><div>名称</div><div>角色</div><div>会话</div><div>状态</div><div /></div>
      <div className="trow">
        <span className="dot ok" />
        <div><div className="name">{local?.name ?? '本机'}</div><div className="sub">{local?.platform === 'darwin' ? 'macOS' : local?.platform ?? ''} · <span className="mono">{local?.home ?? ''}</span></div></div>
        <div>本机</div>
        <div>{localSessions.filter((s) => s.status !== 'orphaned').length} 条会话{running ? ` · ${running} 运行中` : ''}</div>
        <div className="sub" style={{ fontSize: 12 }}>在线</div>
        <div className="acts"><button className="link" onClick={() => onNewOn('local')}>在它上新建</button></div>
      </div>
      {remote.map((m) => {
        const isOnline = m.online && m.reachable;
        return (
          <div className="trow" key={m.name}>
            <span className={`dot ${isOnline ? 'ok' : 'off'}`} />
            <div><div className="name">{m.name}</div><div className="sub">{m.platform ?? ''}{m.version ? ` · ${m.version}` : ''}</div></div>
            <div>被控</div>
            <div>{m.sessions.length} 条会话{m.activeCount ? ` · ${m.activeCount} 运行中` : ''}</div>
            <div className="sub" style={{ fontSize: 12 }}>{isOnline ? '在线' : m.online ? '中继在线 · 探活未通' : '离线'}</div>
            <div className="acts">{isOnline ? <button className="link" onClick={() => onNewOn(m.name)}>在它上新建</button> : <span className="link dim">离线</span>}</div>
          </div>
        );
      })}
      {!fleet?.configured && <p className="lead" style={{ marginTop: 14 }}>还没配置中继:手机和其他机器要通过中继才能找到这台 Mac。配置在旧版设置 → LeoPhone 里,2.0 的设置页下一步接入。</p>}
      <div className="pair">
        <div>
          <h3>扫码加身体 —— 和 iPhone 上的入口同名</h3>
          <ol>
            <li>iPhone 打开 LeoPhoneAgent → 设备 → <b>扫码加身体</b></li>
            <li>输入下面的配对码(10 分钟有效)</li>
            <li>钥匙只跟这个码里的中继根走,不会发到别的地址</li>
          </ol>
          {joinToken ? <code>{joinToken}</code> : <button className="link" onClick={mintToken} disabled={!fleet?.configured}>生成配对码</button>}
        </div>
        <div />
      </div>
    </div></section>
  );
}

// ---------------------------------------------------------------- 通道

type TelegramStatus = {
  enabled: boolean; configured: boolean; running: boolean; botUsername: string | null; apiBase: string;
  allowedChats: number[]; defaultCwd: string; model: string | null; policy: string;
  pairingCode: string | null; pairingExpiresAt: number | null; boundSessions: string[]; lastError: string | null;
};

export function ChannelsPage({ toast, models }: { toast: (text: string, error?: boolean) => void; models: Array<{ provider: string; providerName: string; id: string; name: string }> }) {
  const [tg, setTg] = useState<TelegramStatus | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ token: '', defaultCwd: '', model: '', policy: 'default', enabled: true });
  const load = async () => { try { setTg((await getJson<{ telegram: TelegramStatus }>('/api/leophone/channels')).telegram); } catch (e) { toast(e instanceof Error ? e.message : '读取通道失败', true); } };
  useEffect(() => { void load(); const id = window.setInterval(() => void load(), 5000); return () => window.clearInterval(id); }, []);
  const openEdit = () => { setForm({ token: '', defaultCwd: tg?.defaultCwd ?? '~', model: tg?.model ?? '', policy: tg?.policy ?? 'default', enabled: tg?.enabled ?? true }); setEditing(true); };
  const save = async () => {
    try {
      await sendJson('/api/leophone/channels/telegram', { ...(form.token ? { token: form.token } : {}), defaultCwd: form.defaultCwd, model: form.model || null, policy: form.policy, enabled: form.enabled }, 'PUT');
      setEditing(false); toast('Telegram 设置已保存'); await load();
    } catch (e) { toast(e instanceof Error ? e.message : '保存失败', true); }
  };
  const pair = async () => { try { await sendJson('/api/leophone/channels/telegram/pairing', {}); await load(); } catch (e) { toast(e instanceof Error ? e.message : '生成配对码失败', true); } };
  const removeChat = async (id: number) => { try { await sendJson(`/api/leophone/channels/telegram/chats/${id}`, {}, 'DELETE'); await load(); } catch (e) { toast(e instanceof Error ? e.message : '移除失败', true); } };
  const statusText = !tg ? '读取中…' : !tg.configured ? '未连接' : !tg.enabled ? '已配置 · 已停用' : tg.lastError ? `出错:${tg.lastError}` : tg.running ? `已连接${tg.botUsername ? ` · @${tg.botUsername}` : ''}` : '启动中…';
  const connected = Boolean(tg?.running && !tg?.lastError);
  return (
    <section className="page"><div className="page-in">
      <div className="page-h"><h1>通道</h1><span className="meta">{connected ? '1 个已连接' : '0 个已连接'}</span></div>
      <p className="lead">在 Telegram 里给机器人说一句话,就是在这台 Mac 上开一条新会话;会话里的「需要确认」会以同一张卡推到 Telegram,点按钮就是批准。手机、Mac、通道看到的是同一条流水。</p>
      <div className="trow ch h"><span /><div>通道</div><div>绑定</div><div>镜像</div><div /></div>
      <div className="trow ch">
        <span className={`dot ${connected ? 'ok' : 'off'}`} />
        <div className="name">Telegram</div>
        <div>{statusText}{tg?.allowedChats.length ? ` · 已配对 ${tg.allowedChats.length} 个聊天` : ''}</div>
        <div className="sub" style={{ fontSize: 12 }}>{tg?.boundSessions.length ? `绑定 ${tg.boundSessions.length} 条会话 · 审批卡 ✓` : '审批卡推所有配对聊天'}</div>
        <div className="acts"><button className="link" onClick={openEdit}>{tg?.configured ? '设置' : '连接'}</button></div>
      </div>
      {editing && (
        <div className="newbox" style={{ borderBottom: 0, borderTop: '1px solid var(--line)' }}>
          <div><label>Bot token(在 Telegram 里找 @BotFather 用 /newbot 创建;只存本机)</label><input type="password" value={form.token} placeholder={tg?.configured ? '留空 = 不改' : '123456:ABC-DEF…'} onChange={(e) => setForm({ ...form, token: e.target.value })} /></div>
          <div className="row2">
            <div><label>默认目录</label><input className="mono" value={form.defaultCwd} onChange={(e) => setForm({ ...form, defaultCwd: e.target.value })} /></div>
            <div><label>审批策略</label><select value={form.policy} onChange={(e) => setForm({ ...form, policy: e.target.value })}>{(['default', 'accept_edits', 'plan', 'auto'] as const).map((p) => <option key={p} value={p}>{POLICY_LABEL[p]}</option>)}</select></div>
          </div>
          <div><label>模型</label><select value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })}><option value="">默认模型</option>{models.map((m) => <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>{m.name} · {m.providerName}</option>)}</select></div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: 'var(--fg2)' }}><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} style={{ width: 'auto' }} />启用(长轮询,不需要公网回调)</label>
          <div className="acts"><button className="btn-g" onClick={() => setEditing(false)}>取消</button><button className="btn-s" onClick={() => void save()}>保存</button></div>
        </div>
      )}
      {tg?.configured && (
        <>
          <div className="sec">配对</div>
          <div className="pair" style={{ marginTop: 8 }}>
            <div>
              <h3>把一个聊天配对到这台 Mac</h3>
              <ol><li>在 Telegram 里打开和机器人的私聊(或把它拉进群)</li><li>点右边「生成配对码」,然后在聊天里发:<code>/pair {tg.pairingCode ?? '······'}</code></li><li>之后直接说话就是开会话;会话里的确认会推到这个聊天</li></ol>
              {tg.pairingCode ? <span className="sub">配对码 <code>{tg.pairingCode}</code> · 10 分钟内有效</span> : <button className="link" onClick={() => void pair()}>生成配对码</button>}
            </div>
            <div />
          </div>
          {tg.allowedChats.length > 0 && (
            <>
              <div className="sec">已配对的聊天</div>
              {tg.allowedChats.map((id) => (
                <div className="trow st" key={id}><span className="dot ok" /><div className="name mono">chat {id}</div><div className="sub" style={{ fontSize: 12 }}>会收到审批卡;在里面说话就开会话</div><div className="acts"><button className="link dim" onClick={() => void removeChat(id)}>移除</button></div></div>
              ))}
            </>
          )}
        </>
      )}
      <div className="trow ch" style={{ marginTop: 18 }}><span className="dot off" /><div className="name">飞书</div><div>未连接</div><div className="sub" style={{ fontSize: 12 }}>—</div><div className="acts"><span className="link dim">排队中</span></div></div>
    </div></section>
  );
}

// ---------------------------------------------------------------- 设置

type LoginFlowState = {
  id: string; provider: string; status: 'running' | 'done' | 'error' | 'cancelled';
  events: Array<{ type: string; message?: string; url?: string; userCode?: string; verificationUri?: string; links?: Array<{ label?: string; url: string }> }>;
  prompt: { id: string; type: string; message: string; placeholder?: string; options?: Array<{ id: string; label: string; description?: string }> } | null;
  error: string | null;
};

/** 一场 OAuth 登录对话:pi-ai 说什么就画什么(打开链接 / 输入代码 / 选一项),答完继续轮询。 */
function LoginFlowPanel({ flowId, onDone, onCancel }: { flowId: string; onDone: () => void; onCancel: () => void }) {
  const [flow, setFlow] = useState<LoginFlowState | null>(null);
  const [answer, setAnswer] = useState('');
  const doneRef = useRef(false);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const next = await getJson<LoginFlowState>(`/api/leophone/pi/login/${flowId}`);
        if (!alive) return;
        setFlow(next);
        if (next.status === 'done' && !doneRef.current) { doneRef.current = true; onDone(); }
      } catch { /* 下次再试 */ }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 1000);
    return () => { alive = false; window.clearInterval(id); };
  }, [flowId, onDone]);
  const reply = async (value: string) => {
    if (!flow?.prompt) return;
    try { await sendJson(`/api/leophone/pi/login/${flowId}/answer`, { value }); setAnswer(''); } catch { /* 面板会显示错误 */ }
  };
  const cancel = async () => { try { await sendJson(`/api/leophone/pi/login/${flowId}/cancel`, {}); } catch { /* ignore */ } onCancel(); };
  const authUrl = [...(flow?.events ?? [])].reverse().find((e) => e.type === 'auth_url')?.url;
  const device = [...(flow?.events ?? [])].reverse().find((e) => e.type === 'device_code');
  const progress = [...(flow?.events ?? [])].reverse().find((e) => e.type === 'progress' || e.type === 'info');
  return (
    <div className="login-flow" style={{ display: 'grid', gap: 6 }}>
      {!flow && <span>正在发起登录…</span>}
      {authUrl && <span>1. 在浏览器里完成授权:<a className="link" href={authUrl} target="_blank" rel="noreferrer" onClick={(e) => { e.preventDefault(); window.open(authUrl, '_blank', 'noopener'); }}>打开授权页面</a></span>}
      {device && <span>2. 输入代码 <code>{device.userCode}</code>{device.verificationUri ? <> 于 <a className="link" href={device.verificationUri} target="_blank" rel="noreferrer">{device.verificationUri}</a></> : null}</span>}
      {progress?.message && <span style={{ color: 'var(--fg3)' }}>{progress.message}</span>}
      {flow?.prompt && (
        <span className="keyform">
          <span>{flow.prompt.message}</span>
          {flow.prompt.type === 'select' ? (
            <select value={answer} onChange={(e) => setAnswer(e.target.value)} style={{ background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 7, padding: '4px 8px' }}>
              <option value="">选一项…</option>
              {(flow.prompt.options ?? []).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          ) : (
            <input autoFocus type={flow.prompt.type === 'secret' ? 'password' : 'text'} placeholder={flow.prompt.placeholder ?? ''} value={answer} onChange={(e) => setAnswer(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void reply(answer); }} />
          )}
          <button className="link" onClick={() => void reply(answer)} disabled={!answer}>提交</button>
        </span>
      )}
      {flow?.status === 'error' && <span style={{ color: 'var(--err-text)' }}>登录失败:{flow.error}</span>}
      {flow?.status === 'done' && <span style={{ color: 'var(--ok-text)' }}>已登录</span>}
      {flow?.status === 'running' && <button className="link dim" onClick={() => void cancel()}>取消</button>}
    </div>
  );
}

function providerStatusText(p: ProviderInfo): string {
  if (p.usingOAuth) return '已登录 · OAuth';
  if (p.usingSubscription) return '订阅 · 已登录';
  if (p.configured) return '密钥有效';
  return '未配置';
}

export function SettingsPage({ toast, onProvidersChanged }: { toast: (text: string, error?: boolean) => void; onProvidersChanged: () => void }) {
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [defaultPolicy, setDefaultPolicy] = useState(readDefaultPolicy());
  const [loginFlow, setLoginFlow] = useState<{ provider: string; flowId: string } | null>(null);
  const [legacyOpen, setLegacyOpen] = useState(false);
  const version = String((import.meta as unknown as { env?: Record<string, string> }).env?.VITE_APP_VERSION ?? '');
  const note = LEO_RELEASE_NOTES[0];

  const load = async () => {
    try { setProviders((await api.providers()).providers); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  useEffect(() => { void load(); }, []);

  const saveKey = async (id: string) => {
    if (!keyDraft.trim()) return;
    try {
      await api.setProviderKey(id, keyDraft.trim());
      setKeyDraft(''); setEditing(null); toast(`${id}:密钥已保存`); onProvidersChanged(); await load();
    } catch (e) { toast(e instanceof Error ? e.message : '保存失败', true); }
  };
  const clearKey = async (id: string) => {
    try { await api.clearProviderKey(id); toast(`${id}:已移除`); onProvidersChanged(); await load(); }
    catch (e) { toast(e instanceof Error ? e.message : '移除失败', true); }
  };
  const startLogin = async (id: string) => {
    try {
      const created = await sendJson<{ flow_id: string }>(`/api/leophone/pi/providers/${encodeURIComponent(id)}/login`, { type: 'oauth' });
      setLoginFlow({ provider: id, flowId: created.flow_id });
    } catch (e) { toast(e instanceof Error ? e.message : '发起登录失败', true); }
  };
  const logout = async (id: string) => {
    try { await sendJson(`/api/leophone/pi/providers/${encodeURIComponent(id)}/logout`, {}); toast(`${id}:已退出`); onProvidersChanged(); await load(); }
    catch (e) { toast(e instanceof Error ? e.message : '退出失败', true); }
  };
  const pickPolicy = (p: string) => {
    setDefaultPolicy(p);
    try { localStorage.setItem(DEFAULT_POLICY_KEY, p); } catch { /* ignore */ }
  };

  const oauthProviders = (providers ?? []).filter((p) => p.oauth);
  const keyProviders = (providers ?? []).filter((p) => !p.oauth);

  const row = (p: ProviderInfo) => (
    <div className="trow pv" key={p.id}>
      <span className={`dot ${p.configured ? 'ok' : 'off'}`} />
      <div><div className="name">{p.name}</div><div className="sub mono">{p.id}</div></div>
      <div style={{ fontSize: 12, color: p.configured ? 'var(--fg)' : 'var(--fg3)' }}>{providerStatusText(p)}</div>
      <div className="sub" style={{ fontSize: 12 }}>{p.models.length ? `${p.models.slice(0, 3).map((m) => m.name).join(' · ')}${p.models.length > 3 ? ` +${p.models.length - 3}` : ''}` : '—'}</div>
      <div className="acts">
        {loginFlow?.provider === p.id ? (
          <LoginFlowPanel flowId={loginFlow.flowId} onDone={() => { toast(`${p.name}:登录成功`); onProvidersChanged(); void load(); window.setTimeout(() => setLoginFlow(null), 1500); }} onCancel={() => setLoginFlow(null)} />
        ) : editing === p.id ? (
          <span className="keyform">
            <input autoFocus type="password" placeholder="粘贴 API 密钥" value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void saveKey(p.id); if (e.key === 'Escape') { setEditing(null); setKeyDraft(''); } }} />
            <button className="link" onClick={() => void saveKey(p.id)}>保存</button>
            <button className="link dim" onClick={() => { setEditing(null); setKeyDraft(''); }}>取消</button>
          </span>
        ) : (
          <>
            {p.oauth && !p.usingOAuth && <button className="link" onClick={() => void startLogin(p.id)}>登录</button>}
            {p.usingOAuth && <button className="link dim" onClick={() => void logout(p.id)}>退出登录</button>}
            <button className="link" onClick={() => { setEditing(p.id); setKeyDraft(''); }}>{p.configured && !p.usingOAuth ? '更换密钥' : '添加密钥'}</button>
            {p.configured && !p.usingOAuth && <button className="link dim" onClick={() => void clearKey(p.id)}>移除</button>}
          </>
        )}
      </div>
    </div>
  );

  return (
    <section className="page"><div className="page-in">
      <div className="page-h"><h1>设置</h1></div>
      <div className="sec">订阅登录 · OAuth(pi-ai 内置登录流程,凭据只存在这台 Mac 的 ~/.leoagent/pi/auth.json)</div>
      {error && <p className="lead" style={{ color: 'var(--err-text)' }}>读取供应商失败:{error}</p>}
      {!providers && !error && <p className="lead">读取中…</p>}
      {providers && <div className="trow pv h"><span /><div>提供方</div><div>凭据</div><div>模型</div><div /></div>}
      {oauthProviders.map(row)}
      <div className="sec">API 密钥</div>
      {keyProviders.map(row)}
      <div className="sec">新会话的默认审批策略</div>
      {(['default', 'accept_edits', 'plan', 'auto'] as const).map((p) => (
        <button className={`radio ${defaultPolicy === p ? 'on' : ''}`} key={p} onClick={() => pickPolicy(p)}>
          <span className="rb" />
          <div><div className="rt">{POLICY_LABEL[p]}</div><div className="rd">{{
            default: '读文件、搜索直接放行;执行命令、写文件、远程操作先问你',
            accept_edits: '连编辑文件也放行,只在执行命令和远程操作时问你',
            plan: '只分析和列计划,不落任何改动',
            auto: '全部放行 —— 只建议在隔离目录或被控机器上用',
          }[p]}</div></div>
        </button>
      ))}
      <div className="sec">更新与数据</div>
      <div className="trow st"><span className="dot ok" /><div className="name">{version || '开发版'}</div><div className="sub" style={{ fontSize: 12 }}>{note ? `本次更新 · ${note.version} · ${note.date}` : '装机后首启弹「本次更新」;版本号不往前走就不弹'}</div><div className="acts"><button className="link" onClick={() => setLegacyOpen(true)}>更多设置(中继 · 语音 · MCP · 通知)</button></div></div>
      {legacyOpen && <Suspense fallback={null}><LegacySettings isOpen initialTab="agents" projects={[]} onClose={() => setLegacyOpen(false)} /></Suspense>}
      <div className="trow st"><span className="dot" /><div className="name">会话数据</div><div className="sub mono" style={{ fontSize: 12 }}>~/.leoagent/harness-sessions · ~/.leoagent/pi</div><div className="acts" /></div>
    </div></section>
  );
}
