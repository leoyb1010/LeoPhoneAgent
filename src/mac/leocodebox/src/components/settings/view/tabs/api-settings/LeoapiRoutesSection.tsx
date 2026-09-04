import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, Check, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';

import { apiClient } from '../../../../../utils/apiClient';
import { Button, Input } from '../../../../../shared/view/ui';
import SettingsSection from '../../SettingsSection';

type Target = { id: string; label: string; writable: boolean };
type Provider = {
  id: string;
  target: string;
  name: string;
  baseUrl: string;
  model: string;
  wireApi: 'responses' | 'chat';
  hasApiKey: boolean;
  discoveredModels?: string[];
  modelDiscoveryError?: string;
  modelDiscovery?: { latencyMs?: number; modelCount?: number; httpStatus?: number } | null;
  modelMapping?: { sonnet?: string; opus?: string; haiku?: string };
};
type SwitchStatus = {
  success: boolean;
  targets: Record<string, Target>;
  activeByTarget: Record<string, string>;
  nativeAvailableByTarget: Record<string, boolean>;
  providers: Provider[];
  health?: {
    enabled: boolean;
    intervalMinutes: number;
    autoFailoverTargets: string[];
    lastRunAt: string | null;
    targets: Record<string, { status: 'ok' | 'degraded' | 'unknown'; lastLatencyMs: number | null; lastNote: string }>;
  };
};
type GatewayStatus = {
  enabled: boolean;
  compaction: boolean;
  baseUrl: string | null;
  meter?: { today?: { requests: number; inputTokens: number; outputTokens: number } };
  compactionMeter?: { requests: number; savedChars: number };
};
type ProviderDraft = {
  id?: string;
  target: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  wireApi: 'responses' | 'chat';
  sonnet: string;
  opus: string;
  haiku: string;
};

const TARGET_ORDER = ['claude', 'codex', 'opencode', 'gemini', 'hermes', 'cursor'];
const emptyDraft = (target: string): ProviderDraft => ({
  target,
  name: '',
  baseUrl: '',
  apiKey: '',
  model: '',
  wireApi: target === 'codex' ? 'responses' : 'chat',
  sonnet: '',
  opus: '',
  haiku: '',
});

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function LeoapiRoutesSection() {
  const [status, setStatus] = useState<SwitchStatus | null>(null);
  const [gateway, setGateway] = useState<GatewayStatus | null>(null);
  const [selectedTarget, setSelectedTarget] = useState('claude');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [draft, setDraft] = useState<ProviderDraft | null>(null);

  const load = useCallback(async () => {
    const [next, nextGateway] = await Promise.all([
      apiClient.get<SwitchStatus>('/api/leocodebox/switch/status'),
      apiClient.get<GatewayStatus>('/api/leocodebox/gateway/status'),
    ]);
    setStatus(next);
    setGateway(nextGateway);
    setSelectedTarget((current) => next.targets[current] ? current : Object.keys(next.targets)[0] || 'claude');
  }, []);

  useEffect(() => {
    void load().catch((error) => setMessage(`读取接口失败：${errorText(error)}`));
  }, [load]);

  const target = status?.targets[selectedTarget];
  const providers = useMemo(
    () => (status?.providers ?? []).filter((provider) => provider.target === selectedTarget),
    [selectedTarget, status?.providers],
  );
  const activeId = status?.activeByTarget[selectedTarget];

  const run = useCallback(async (key: string, operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    setMessage('');
    try {
      await operation();
      await load();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(null);
    }
  }, [busy, load]);

  const edit = (provider: Provider) => setDraft({
    id: provider.id,
    target: provider.target,
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: '',
    model: provider.model,
    wireApi: provider.wireApi,
    sonnet: provider.modelMapping?.sonnet || '',
    opus: provider.modelMapping?.opus || '',
    haiku: provider.modelMapping?.haiku || '',
  });

  const save = () => draft && run(`save:${draft.id || 'new'}`, async () => {
    const result = await apiClient.post<{ provider: Provider; discovery?: string }>('/api/leocodebox/switch/providers', {
      id: draft.id,
      target: draft.target,
      name: draft.name,
      baseUrl: draft.baseUrl,
      apiKey: draft.id && !draft.apiKey ? '__KEEP__' : draft.apiKey,
      model: draft.model,
      wireApi: draft.wireApi,
      modelMapping: { sonnet: draft.sonnet, opus: draft.opus, haiku: draft.haiku },
      autoDiscover: Boolean(draft.baseUrl && (draft.apiKey || draft.id)),
    });
    setSelectedTarget(result.provider.target);
    setDraft(null);
    setMessage(result.discovery === 'pending' ? '已保存，正在后台发现模型。' : '接口已保存。');
  });

  const applyProvider = (provider: Provider) => run(`apply:${provider.id}`, async () => {
    const preview = await apiClient.get<{
      diff?: Array<{ filePath: string; before: string | null; after: string | null; changed: boolean }>;
    }>(`/api/leocodebox/switch/providers/${encodeURIComponent(provider.id)}/preview`);
    const changed = (preview.diff ?? []).filter((entry) => entry.changed);
    const summary = changed.length
      ? changed.map((entry) => `• ${entry.filePath}`).join('\n')
      : '没有文件变化';
    if (!window.confirm(`确认将“${provider.name}”用于 ${target?.label || provider.target}？\n\n将修改：\n${summary}\n\n系统会先备份，失败时自动回滚。`)) return;
    await apiClient.post(`/api/leocodebox/switch/providers/${encodeURIComponent(provider.id)}/apply`, {});
    window.dispatchEvent(new CustomEvent('leocodebox-provider:applied', {
      detail: { target: provider.target, activeModel: provider.model || null },
    }));
    setMessage(`已启用 ${provider.name}，对新会话生效。`);
  });

  const testProvider = (provider: Provider) => run(`test:${provider.id}`, async () => {
    const result = await apiClient.post<{ reachable?: boolean; latencyMs?: number; httpStatus?: number }>(
      `/api/leocodebox/switch/providers/${encodeURIComponent(provider.id)}/test`,
      {},
    );
    setMessage(result.reachable
      ? `连接正常${Number.isFinite(result.latencyMs) ? ` · ${result.latencyMs} ms` : ''}`
      : `连接失败${result.httpStatus ? ` · HTTP ${result.httpStatus}` : ''}`);
  });

  const deleteProvider = (provider: Provider) => {
    if (!window.confirm(`确认删除“${provider.name}”？已写入 CLI 的配置不会自动还原。`)) return;
    void run(`delete:${provider.id}`, async () => {
      await apiClient.delete(`/api/leocodebox/switch/providers/${encodeURIComponent(provider.id)}`);
      setMessage('接口已删除。');
    });
  };

  const restoreNative = () => {
    if (!window.confirm(`确认让 ${target?.label || selectedTarget} 恢复启用 LeoAPI 前的本机配置？`)) return;
    void run(`restore:${selectedTarget}`, async () => {
      await apiClient.post(`/api/leocodebox/switch/targets/${encodeURIComponent(selectedTarget)}/restore-default`, {});
      window.dispatchEvent(new CustomEvent('leocodebox-provider:applied', { detail: { target: selectedTarget, activeModel: null } }));
      setMessage('已恢复本机原配置。');
    });
  };

  const importProviders = (kind: 'current' | 'cc-switch') => run(`import:${kind}`, async () => {
    const path = kind === 'current' ? 'import-current' : 'import-cc-switch';
    const result = await apiClient.post<{ imported?: Provider[]; dbFound?: boolean }>(`/api/leocodebox/switch/${path}`, {});
    setMessage(kind === 'cc-switch' && result.dbFound === false
      ? '没有发现 CC Switch 数据库。'
      : `已导入 ${result.imported?.length ?? 0} 个接口；请确认后再启用。`);
  });

  const toggleGateway = () => run('gateway', async () => {
    await apiClient.put('/api/leocodebox/gateway/toggle', { enabled: !gateway?.enabled });
    setMessage(gateway?.enabled ? '本机统一网关已关闭。' : '本机统一网关已开启。');
  });

  const toggleCompaction = () => run('compaction', async () => {
    await apiClient.put('/api/leocodebox/gateway/compaction', { enabled: !gateway?.compaction });
    setMessage(gateway?.compaction ? '自动上下文保护已关闭。' : '自动上下文保护已开启。');
  });

  const toggleHealth = () => run('health', async () => {
    await apiClient.post('/api/leocodebox/switch/health/settings', {
      enabled: !status?.health?.enabled,
    });
    setMessage(status?.health?.enabled ? '线路健康监测已关闭。' : '线路健康监测已开启。');
  });

  const toggleAutoFailover = () => run(`failover:${selectedTarget}`, async () => {
    const current = status?.health?.autoFailoverTargets ?? [];
    const enabled = current.includes(selectedTarget);
    await apiClient.post('/api/leocodebox/switch/health/settings', {
      autoFailoverTargets: enabled
        ? current.filter((id) => id !== selectedTarget)
        : [...current, selectedTarget],
    });
    setMessage(enabled ? '当前智能体已关闭自动切换。' : '当前智能体已开启自动切换；连续失败后才会切换。');
  });

  const checkHealth = () => run('health-check', async () => {
    await apiClient.post('/api/leocodebox/switch/health/check-now', {});
    setMessage('线路检测已完成。');
  });

  return (
    <SettingsSection
      title="模型接口与线路"
      description="LeoAPI 已并入设置。这里统一管理 Claude Code、Codex、OpenCode、Gemini CLI 与 Hermes 的接口、模型、测速和回滚。"
    >
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="grid gap-2 border-b border-border bg-muted/35 p-3 md:grid-cols-3">
          <div className="rounded-lg border border-border bg-background p-3">
            <div className="flex items-center justify-between gap-2"><div><p className="text-xs font-semibold">本机统一网关</p><p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{gateway?.baseUrl || '尚未启用'}</p></div><Button size="sm" variant={gateway?.enabled ? 'default' : 'outline'} onClick={() => void toggleGateway()} disabled={Boolean(busy)}>{gateway?.enabled ? '已开启' : '开启'}</Button></div>
          </div>
          <div className="rounded-lg border border-border bg-background p-3">
            <div className="flex items-center justify-between gap-2"><div><p className="text-xs font-semibold">自动上下文保护</p><p className="mt-0.5 text-[10px] text-muted-foreground">已节省 {gateway?.compactionMeter?.savedChars ?? 0} 字符</p></div><Button size="sm" variant={gateway?.compaction ? 'default' : 'outline'} onClick={() => void toggleCompaction()} disabled={Boolean(busy)}>{gateway?.compaction ? '已开启' : '开启'}</Button></div>
          </div>
          <div className="rounded-lg border border-border bg-background p-3">
            <div className="flex items-center justify-between gap-2"><div><p className="text-xs font-semibold">线路健康监测</p><p className="mt-0.5 text-[10px] text-muted-foreground">{status?.health?.lastRunAt ? '已有最新检测结果' : '尚未执行检测'}</p></div><Button size="sm" variant={status?.health?.enabled ? 'default' : 'outline'} onClick={() => void toggleHealth()} disabled={Boolean(busy)}>{status?.health?.enabled ? '已开启' : '开启'}</Button></div>
          </div>
        </div>
        <div className="flex flex-wrap gap-1 border-b border-border p-2" role="tablist" aria-label="智能体接口">
          {TARGET_ORDER.filter((id) => status?.targets[id]).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={selectedTarget === id}
              onClick={() => { setSelectedTarget(id); setDraft(null); setMessage(''); }}
              className={`rounded-lg px-3 py-2 text-xs font-medium ${selectedTarget === id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}`}
            >
              {status?.targets[id]?.label || id}
            </button>
          ))}
        </div>

        <div className="space-y-3 p-3 md:p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => setDraft(emptyDraft(selectedTarget))} disabled={!target?.writable || Boolean(busy)}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />新增接口
            </Button>
            <Button size="sm" variant="outline" onClick={() => void importProviders('current')} disabled={Boolean(busy)}>导入当前配置</Button>
            <Button size="sm" variant="outline" onClick={() => void importProviders('cc-switch')} disabled={Boolean(busy)}>从 CC Switch 导入</Button>
            {status?.nativeAvailableByTarget[selectedTarget] && (
              <Button size="sm" variant="outline" onClick={restoreNative} disabled={Boolean(busy)}>
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />恢复本机原配置
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => void checkHealth()} disabled={Boolean(busy)}>立即检测</Button>
            <Button size="sm" variant={status?.health?.autoFailoverTargets.includes(selectedTarget) ? 'default' : 'outline'} onClick={() => void toggleAutoFailover()} disabled={Boolean(busy) || providers.length < 2}>
              {status?.health?.autoFailoverTargets.includes(selectedTarget) ? '已自动切换' : '自动切换'}
            </Button>
          </div>

          {message && <p role="status" className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">{message}</p>}

          {draft && (
            <form className="grid gap-3 rounded-xl border border-border bg-background p-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="space-y-1 text-xs text-muted-foreground">名称<Input required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
                <label className="space-y-1 text-xs text-muted-foreground">请求协议<select value={draft.wireApi} onChange={(event) => setDraft({ ...draft, wireApi: event.target.value as ProviderDraft['wireApi'] })} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"><option value="responses">Responses</option><option value="chat">Chat Completions</option></select></label>
                <label className="space-y-1 text-xs text-muted-foreground md:col-span-2">接口地址<Input inputMode="url" value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></label>
                <label className="space-y-1 text-xs text-muted-foreground">模型<Input list="leoapi-models" value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} /></label>
                <label className="space-y-1 text-xs text-muted-foreground">API Key<Input type="password" autoComplete="new-password" value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} placeholder={draft.id ? '留空保留原密钥' : '可选'} /></label>
              </div>
              <datalist id="leoapi-models">{providers.flatMap((provider) => provider.discoveredModels ?? []).map((model) => <option key={model} value={model} />)}</datalist>
              {draft.target === 'claude' && <div className="grid gap-3 md:grid-cols-3"><label className="space-y-1 text-xs text-muted-foreground">Sonnet<Input value={draft.sonnet} onChange={(event) => setDraft({ ...draft, sonnet: event.target.value })} /></label><label className="space-y-1 text-xs text-muted-foreground">Opus<Input value={draft.opus} onChange={(event) => setDraft({ ...draft, opus: event.target.value })} /></label><label className="space-y-1 text-xs text-muted-foreground">Haiku<Input value={draft.haiku} onChange={(event) => setDraft({ ...draft, haiku: event.target.value })} /></label></div>}
              <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setDraft(null)}>取消</Button><Button type="submit" disabled={Boolean(busy)}>保存接口</Button></div>
            </form>
          )}

          {!draft && providers.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">还没有自定义接口。可以继续使用 CLI 原生登录，或在这里新增一个。</p>}
          {!draft && providers.map((provider) => {
            const active = provider.id === activeId;
            const latency = provider.modelDiscovery?.latencyMs;
            return (
              <article key={provider.id} className={`flex flex-col gap-3 rounded-xl border p-3 md:flex-row md:items-center ${active ? 'border-primary/35 bg-primary/[0.05]' : 'border-border bg-background'}`}>
                <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h4 className="text-sm font-semibold text-foreground">{provider.name}</h4>{active && <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary"><Check className="h-3 w-3" />使用中</span>}</div><p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{provider.baseUrl || '本机默认地址'} · {provider.model || '默认模型'}{provider.hasApiKey ? ' · 已保存密钥' : ''}</p>{provider.modelDiscoveryError && <p className="mt-1 text-[11px] text-destructive">模型发现失败：{provider.modelDiscoveryError}</p>}</div>
                <div className="flex flex-wrap items-center gap-1.5"><Button size="sm" variant="ghost" onClick={() => void testProvider(provider)} disabled={Boolean(busy)}><Activity className="mr-1 h-3.5 w-3.5" />{Number.isFinite(latency) ? `${latency} ms` : '测速'}</Button><Button size="sm" variant="ghost" onClick={() => edit(provider)} disabled={Boolean(busy)}><Pencil className="h-3.5 w-3.5" /><span className="sr-only">编辑 {provider.name}</span></Button>{!active && target?.writable && <Button size="sm" onClick={() => void applyProvider(provider)} disabled={Boolean(busy)}>启用</Button>}<Button size="sm" variant="ghost" onClick={() => deleteProvider(provider)} disabled={Boolean(busy)}><Trash2 className="h-3.5 w-3.5" /><span className="sr-only">删除 {provider.name}</span></Button></div>
              </article>
            );
          })}
        </div>
      </div>
    </SettingsSection>
  );
}
