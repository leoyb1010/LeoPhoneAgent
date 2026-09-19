import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api, sendJson, type FleetOverview, type LocalOverview, type ProviderInfo } from './api';
import { POLICY_LABEL } from './model';
import { LEO_RELEASE_NOTES } from '../components/version-upgrade/releaseNotes';

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

export function ChannelsPage() {
  return (
    <section className="page"><div className="page-in">
      <div className="page-h"><h1>通道</h1><span className="meta">0 个已连接</span></div>
      <p className="lead">在通道里 @机器人 说一句话,就是在默认机器上开一条新会话;会话里的「需要确认」会以同一张卡推到通道,点按钮就是批准。手机、Mac、通道看到的是同一条流水。</p>
      <div className="trow ch h"><span /><div>通道</div><div>绑定</div><div>镜像</div><div /></div>
      <div className="trow ch"><span className="dot off" /><div className="name">Telegram</div><div>未连接 · 2.0 阶段 3 接入</div><div className="sub" style={{ fontSize: 12 }}>—</div><div className="acts"><span className="link dim">即将支持</span></div></div>
      <div className="trow ch"><span className="dot off" /><div className="name">飞书</div><div>未连接</div><div className="sub" style={{ fontSize: 12 }}>—</div><div className="acts"><span className="link dim">排队中</span></div></div>
    </div></section>
  );
}

// ---------------------------------------------------------------- 设置

function providerStatusText(p: ProviderInfo): string {
  if (p.usingOAuth) return '已登录 · OAuth';
  if (p.usingSubscription) return '订阅 · 已登录';
  if (p.configured) return '密钥有效';
  return '未配置';
}

export function SettingsPage({ toast, onProvidersChanged }: { toast: (text: string, error?: boolean) => void; onProvidersChanged: () => void }) {
  const navigate = useNavigate();
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [defaultPolicy, setDefaultPolicy] = useState(readDefaultPolicy());
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
        {editing === p.id ? (
          <span className="keyform">
            <input autoFocus type="password" placeholder="粘贴 API 密钥" value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void saveKey(p.id); if (e.key === 'Escape') { setEditing(null); setKeyDraft(''); } }} />
            <button className="link" onClick={() => void saveKey(p.id)}>保存</button>
            <button className="link dim" onClick={() => { setEditing(null); setKeyDraft(''); }}>取消</button>
          </span>
        ) : (
          <>
            {p.oauth && <span className="link dim" title="OAuth 登录在下一步接入">登录(即将)</span>}
            <button className="link" onClick={() => { setEditing(p.id); setKeyDraft(''); }}>{p.configured && !p.usingOAuth ? '更换密钥' : '添加密钥'}</button>
            {p.configured && <button className="link dim" onClick={() => void clearKey(p.id)}>移除</button>}
          </>
        )}
      </div>
    </div>
  );

  return (
    <section className="page"><div className="page-in">
      <div className="page-h"><h1>设置</h1></div>
      <div className="sec">订阅登录 · OAuth(pi-ai 内置登录流程;本版先支持粘贴密钥,登录按钮下一步接入)</div>
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
      <div className="trow st"><span className="dot ok" /><div className="name">{version || '开发版'}</div><div className="sub" style={{ fontSize: 12 }}>{note ? `本次更新 · ${note.version} · ${note.date}` : '装机后首启弹「本次更新」;版本号不往前走就不弹'}</div><div className="acts"><button className="link" onClick={() => navigate('/legacy')}>旧版界面</button></div></div>
      <div className="trow st"><span className="dot" /><div className="name">会话数据</div><div className="sub mono" style={{ fontSize: 12 }}>~/.leoagent/harness-sessions · ~/.leoagent/pi</div><div className="acts" /></div>
    </div></section>
  );
}
