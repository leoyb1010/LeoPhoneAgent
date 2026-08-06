/**
 * modelVisibilityPrefs —— 按「(agent, 来源/provider, model) → 是否在模型选择器显示」的
 * **用户本地 override**,localStorage 持久化,跨会话 / 跨重启在本机生效。
 *
 * 背景:
 *   每个来源(provider)在某个 agent 下可能提供很多模型(XD 网关 Claude Code 有 20 个),
 *   用户本地全列出来会很长。设置 → 模型供应商 展开来源后,用户可逐个开关哪些模型显示。
 *   这里只存**用户显式改过的那些**(override),没改过的模型跟随目录里的系统默认值
 *   (CatalogModel.defaultEnabled,缺省 ⇒ 开)。
 *
 * 为什么 key 必须带 agent:
 *   同一来源可同时服务多个 agent(XD = claude-code + codex),且两个 agent 下模型集不同、
 *   同名模型元数据也不同(gpt-5.5 cc=1M / codex=272k)。开关必须 per-agent 独立,否则
 *   在 Claude Code 下关掉 gpt-5.5 会连带影响 Codex。key = `${agent}:${providerId}:${modelId}`。
 *
 * 与系统默认值的关系(对齐 CLAUDE.md 规则 20):
 *   - 本 store 只记 override(布尔),**不**快照系统默认值。
 *   - 未被 override 的模型永远跟随当前版本目录的 defaultEnabled —— 新增模型默认开,
 *     未自定义的用户随版本自然吃到。
 *   - 「全部开启 / 全部关闭」是显式批量动作 → 为当前 agent 该来源的每个模型写显式 override。
 *
 * 谁读谁写:
 *   - 写:ProvidersSection 的模型开关 / 批量按钮(setModelVisibility / setManyVisibility)。
 *   - 读:ModelSelector 的右栏过滤(isModelEnabled);ProvidersSection 的计数与开关态。
 *
 * 持久化频率低(仅用户点开关触发),同步写 localStorage,不做 batch / debounce —— 与
 * providerModelMemory / newMakerDraft 取舍一致(避免热更新 relaunch 强退丢最近一次改动)。
 * 另外维护一个递增 version + 订阅者集合,供 useSyncExternalStore 让消费组件在开关变更后
 * 实时重算(设置页与聊天页可能同时挂载:设置里改完、返回聊天,ModelSelector 不重挂也能刷新)。
 */

import { useSyncExternalStore } from 'react';

import { isModelVisible } from '@cindy/model-providers';

import type { AgentKind } from '@/hooks/useAgentCapabilities';

const STORAGE_KEY = 'xdt:modelVisibilityPrefs:v1';

/** override 表:key=`${agent}:${providerId}:${modelId}` → 用户显式设定的可见性。 */
type VisibilityMap = Record<string, boolean>;

function keyOf(agent: AgentKind, providerId: string, modelId: string): string {
  return `${agent}:${providerId}:${modelId}`;
}

/**
 * 严格校验:只保留 value 为 boolean 的条目。老版本 / 手改 localStorage 损坏时静默回退空表。
 */
function sanitize(raw: unknown): VisibilityMap {
  if (!raw || typeof raw !== 'object') return {};
  const out: VisibilityMap = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k && typeof v === 'boolean') out[k] = v;
  }
  return out;
}

// 进程内缓存(惰性加载)。读多写少,避免每次读都 parse localStorage。
let cache: VisibilityMap | null = null;

function load(): VisibilityMap {
  if (cache) return cache;
  if (typeof window === 'undefined') {
    cache = {};
    return cache;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    cache = raw ? sanitize(JSON.parse(raw)) : {};
  } catch {
    cache = {};
  }
  // 首次加载后把整张快照镜像给 main —— 让 IM /model 在 main 侧拿到用户的可见性 override
  // (override 真源仍是本地 localStorage,main 只缓存副本)。覆盖「用户从不打开模型选择器、
  // 但用 IM /model」的场景:任意 isModelEnabled 读取都会触发本次首推。
  mirrorToMain(cache);
  return cache;
}

/**
 * 单向把整张 override 快照推给 main(fire-and-forget)。main 缓存后供 IM `/model` 派生模型
 * 列表时复用同一套可见性过滤,保证 IM 与应用内列表逐模型一致。失败静默(非 electron / preload
 * 未就绪 / 测试环境),不影响本地读写。
 */
function mirrorToMain(map: VisibilityMap): void {
  try {
    void window.electronAPI?.maker?.syncModelVisibility?.(map);
  } catch {
    // ignore — 镜像失败不影响本地可见性逻辑
  }
}

// ── 订阅 / 版本(供 useSyncExternalStore)──────────────────────────────────
let version = 0;
const listeners = new Set<() => void>();

function persist(map: VisibilityMap): void {
  cache = map;
  version += 1;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    } catch {
      // localStorage 满 / 私密窗口禁写 —— 忽略,不影响内存缓存。
    }
  }
  // 每次开关变更后把最新快照重推 main,保持 IM /model 与应用内可见性一致。
  mirrorToMain(map);
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getVersion(): number {
  return version;
}

/**
 * 该 (agent, 来源, 模型) 当前是否应显示:用户 override 优先,否则跟随目录默认值。
 * model 至少需带 id + 可选 defaultEnabled(直接传 CatalogModel 即可)。
 * 决策走共享包 `isModelVisible`(与 main 侧 IM /model 同一套口径,见 @cindy/model-providers)。
 */
export function isModelEnabled(
  agent: AgentKind,
  providerId: string,
  model: { id: string; defaultEnabled?: boolean },
): boolean {
  return isModelVisible(load()[keyOf(agent, providerId, model.id)], model.defaultEnabled);
}

/** 写单个 (agent, 来源, 模型) 的可见性 override。同值短路,避免无意义落盘 / 通知。 */
export function setModelVisibility(
  agent: AgentKind,
  providerId: string,
  modelId: string,
  enabled: boolean,
): void {
  if (!providerId || !modelId) return;
  const map = load();
  const k = keyOf(agent, providerId, modelId);
  if (map[k] === enabled) return;
  persist({ ...map, [k]: enabled });
}

/**
 * 批量写某 (agent, 来源) 下一组模型的可见性 override(「全部开启 / 全部关闭」用)。
 * 写显式 override(而非清除)——保证即便某模型目录默认是关,「全部开启」后它也显示。
 * 单次落盘 + 单次通知。无变化则短路。
 */
export function setManyVisibility(
  agent: AgentKind,
  providerId: string,
  modelIds: readonly string[],
  enabled: boolean,
): void {
  if (!providerId || modelIds.length === 0) return;
  const map = load();
  let changed = false;
  const next = { ...map };
  for (const id of modelIds) {
    const k = keyOf(agent, providerId, id);
    if (next[k] !== enabled) {
      next[k] = enabled;
      changed = true;
    }
  }
  if (changed) persist(next);
}

/**
 * useSyncExternalStore 包装 —— 返回递增 version。组件把它作为 useMemo 依赖,
 * 开关变更后自动重算(计数 / 过滤后的模型列表)。
 */
export function useModelVisibilityVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}

/** 测试用 —— 重置缓存 + 清 localStorage(其它代码不应调用)。 */
export function __resetForTest(): void {
  cache = null;
  version = 0;
  listeners.clear();
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }
}

export const __STORAGE_KEY = STORAGE_KEY;
