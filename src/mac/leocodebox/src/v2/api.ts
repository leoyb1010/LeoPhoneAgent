import { authenticatedFetch } from '../utils/apiClient';

// 2.0 渲染层与服务端的全部往来。本机会话走 /api/leophone/local/*(直连 HarnessManager),
// 远程机器走 /api/leophone/fleet/*(中继代理)。两条路吐同一种事件词汇。

export type SessionTarget = { machine: 'local' | string; id: string };

export type LastEvent = { event: string; text: string; timestamp: number; mode?: string } | null;

export type SessionSummary = {
  session_id: string;
  harness: string;
  name: string;
  cwd: string;
  status: string;
  model: string | null;
  policy: string;
  title: string;
  last_event: LastEvent;
  created_at: number;
  updated_at: number;
  seq: number;
  waiting_for_approval: boolean;
  pending_approvals: Array<{ approval_id: string; command: string; choices: string[] }>;
  window?: { app?: string; title?: string; snapshotId?: string; snapshot_id?: string } | null;
  resumable?: boolean;
};

export type LocalOverview = {
  name: string;
  platform: string;
  home: string;
  harnesses: Array<{ key: string; name: string; executable: string }>;
  providers: Record<string, 'api_key' | 'oauth'>;
  sessions: SessionSummary[];
};

export type FleetMachine = {
  name: string;
  online: boolean;
  reachable: boolean;
  platform?: string;
  server?: string;
  version?: string;
  activeCount: number;
  sessions: Array<Partial<SessionSummary> & { session_id: string; status: string }>;
};

export type FleetOverview = { configured: boolean; localName: string; relayApiRoot: string; machines: FleetMachine[] };

export type ProviderInfo = {
  id: string;
  name: string;
  oauth: boolean;
  custom?: boolean;
  baseUrl?: string | null;
  configured: boolean;
  usingOAuth: boolean;
  usingSubscription: boolean;
  status: unknown;
  models: Array<{ id: string; name: string; reasoning?: boolean; contextWindow?: number | null }>;
};

export type HarnessEvent = { event: string; seq?: number; session_id?: string; timestamp?: number } & Record<string, unknown>;

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json();
    return String(body?.error?.message ?? body?.message ?? response.statusText);
  } catch {
    return response.statusText || `HTTP ${response.status}`;
  }
}

export async function getJson<T>(url: string): Promise<T> {
  const response = await authenticatedFetch(url);
  if (!response.ok) throw new Error(await readError(response));
  return response.json() as Promise<T>;
}

export async function sendJson<T = unknown>(url: string, body: unknown, method = 'POST'): Promise<T> {
  const response = await authenticatedFetch(url, { method, body: JSON.stringify(body ?? {}) });
  if (!response.ok) throw new Error(await readError(response));
  return response.json() as Promise<T>;
}

function sessionBase(target: SessionTarget): string {
  return target.machine === 'local'
    ? `/api/leophone/local/sessions/${encodeURIComponent(target.id)}`
    : `/api/leophone/fleet/machines/${encodeURIComponent(target.machine)}/sessions/${encodeURIComponent(target.id)}`;
}

export const api = {
  local: () => getJson<LocalOverview>('/api/leophone/local'),
  fleet: () => getJson<FleetOverview>('/api/leophone/fleet'),
  providers: () => getJson<{ providers: ProviderInfo[]; auth: Record<string, string> }>('/api/leophone/pi/providers'),
  setProviderKey: (providerId: string, key: string) => sendJson(`/api/leophone/pi/providers/${encodeURIComponent(providerId)}/key`, { key }, 'PUT'),
  clearProviderKey: (providerId: string) => sendJson(`/api/leophone/pi/providers/${encodeURIComponent(providerId)}/key`, {}, 'DELETE'),
  upsertCustomProvider: (input: { id: string; name?: string; baseUrl: string; api?: string; key?: string; modelId?: string; modelName?: string }) =>
    sendJson('/api/leophone/pi/custom-providers', input, 'PUT'),
  addCustomModel: (providerId: string, input: { id: string; name?: string }) =>
    sendJson(`/api/leophone/pi/custom-providers/${encodeURIComponent(providerId)}/models`, input, 'PUT'),
  removeCustomProvider: (providerId: string) =>
    sendJson(`/api/leophone/pi/custom-providers/${encodeURIComponent(providerId)}`, {}, 'DELETE'),

  pickLocalFolder: () => sendJson<{ path?: string; cancelled?: boolean }>('/api/leophone/local/folder/pick', {}),
  revealLocalPath: (target: string) => sendJson<{ ok: true; path: string }>('/api/leophone/local/folder/reveal', { path: target }),
  openLocalPath: (target: string) => sendJson<{ ok: true; path: string }>('/api/leophone/local/folder/open', { path: target }),
  openLocalTerminal: (target: string) => sendJson<{ ok: true; path: string }>('/api/leophone/local/folder/term', { path: target }),
  dropLocalFile: (cwd: string, input: { name?: string; content?: string; fromPath?: string }) =>
    sendJson<{ path: string; name: string }>('/api/leophone/local/drop', { cwd, ...input }),
  ensureWorkspace: (cwd: string) =>
    sendJson<{ projectId: string; path: string; fullPath: string; displayName: string }>('/api/leophone/local/workspace', { cwd }),
  readProjectFile: (projectId: string, filePath: string) =>
    getJson<{ content: string; path: string }>(`/api/projects/${encodeURIComponent(projectId)}/file?filePath=${encodeURIComponent(filePath)}`),
  writeProjectFile: (projectId: string, filePath: string, content: string) =>
    sendJson<{ success: boolean; path: string }>(`/api/projects/${encodeURIComponent(projectId)}/file`, { filePath, content }, 'PUT'),
  revertLocalFile: (target: SessionTarget, file: string) =>
    sendJson<{ action: 'restored' | 'removed'; file: string }>(`${sessionBase(target)}/file/revert`, { file }),
  commitLocalFiles: (target: SessionTarget, input: { message: string; files: string[] }) =>
    sendJson<{ hash: string; files: string[]; message: string }>(`${sessionBase(target)}/file/commit`, input),
  pushLocalRepo: (target: SessionTarget) =>
    sendJson<{ remote: string; branch: string }>(`${sessionBase(target)}/push`, {}),
  pullLocalRepo: (target: SessionTarget) =>
    sendJson<{ remote: string; branch: string; changed: boolean }>(`${sessionBase(target)}/pull`, {}),
  diffLocalFile: (target: SessionTarget, file: string) =>
    sendJson<{ file: string; kind: 'modified' | 'added' | 'clean' | 'binary'; patch: string }>(`${sessionBase(target)}/file/diff`, { file }),
  searchLocalCwd: (target: SessionTarget, query: string) =>
    sendJson<{ query: string; hits: Array<{ file: string; line: number; text: string }>; truncated: boolean }>(`${sessionBase(target)}/search`, { query }),
  listLocalCommits: (target: SessionTarget) =>
    sendJson<{ commits: Array<{ hash: string; subject: string; at: number }> }>(`${sessionBase(target)}/log`, {}),
  showLocalCommit: (target: SessionTarget, hash: string) =>
    sendJson<{ hash: string; subject: string; patch: string }>(`${sessionBase(target)}/log`, { hash }),
  applyLocalPatch: (target: SessionTarget, patch: string) =>
    sendJson<{ files: string[] }>(`${sessionBase(target)}/apply`, { patch }),
  packLocalChanges: (target: SessionTarget, input: { name: string; files?: string[] }) =>
    sendJson<{ path: string; name: string; files: string[] }>(`${sessionBase(target)}/pack`, input),
  unpackLocalZip: (target: SessionTarget, input: { name?: string } = {}) =>
    sendJson<{ name: string; files: string[] }>(`${sessionBase(target)}/unpack`, input),
  seedLocalFile: (target: SessionTarget, input: { name: string; text: string }) =>
    sendJson<{ path: string; file: string }>(`${sessionBase(target)}/seed`, input),
  exportLocalTalk: (target: SessionTarget, input: { name: string; markdown: string }) =>
    sendJson<{ path: string; name: string }>(`${sessionBase(target)}/export`, input),
  createLocalSession: (input: { cwd: string; prompt: string; model?: string | null; policy?: string; harness?: string }) =>
    sendJson<{ session_id: string; session: SessionSummary }>('/api/leophone/local/sessions', { harness: 'pi', ...input }),
  createRemoteSession: (input: { machine: string; prompt: string; cwd?: string; harness?: string; model?: string | null; policy?: string }) =>
    sendJson<{ session_id: string }>('/api/leophone/fleet/sessions', { harness: 'pi', ...input }),

  summary: (target: SessionTarget) => getJson<SessionSummary>(sessionBase(target)),
  listArtifacts: (target: SessionTarget) =>
    getJson<{ artifacts: Array<{ name: string; size: number; mime: string }> }>(`${sessionBase(target)}/artifacts`),
  readSessionArtifact: (target: SessionTarget, name: string) =>
    getJson<{ content: string; name: string }>(`${sessionBase(target)}/artifacts/${encodeURIComponent(name)}/text`),
  send: (target: SessionTarget, text: string) => sendJson(`${sessionBase(target)}/send`, { text }),
  stop: (target: SessionTarget) => sendJson(`${sessionBase(target)}/stop`, {}),
  listSessionWindows: (target: SessionTarget) =>
    getJson<{ ok: true; windows: Array<{ snapshotId: string; app: string; title: string; pid: number; windowId: string; frontmost: boolean }> }>(`${sessionBase(target)}/windows`),
  bindSessionWindow: (target: SessionTarget, snapshotId?: string) =>
    sendJson<{ ok: true; app: string; title: string }>(`${sessionBase(target)}/window/bind`, snapshotId ? { snapshotId } : {}),
  peekBoundWindow: (target: SessionTarget) =>
    getJson<{ ok: true; app: string; title: string; image: { mimeType: string; data: string; width: number; height: number } | null }>(`${sessionBase(target)}/window/peek`),
  raiseBoundWindow: (target: SessionTarget) => sendJson<{ ok: true; app: string; title: string }>(`${sessionBase(target)}/window/raise`, {}),
  clickBoundWindow: (target: SessionTarget, point: { x: number; y: number }) =>
    sendJson<{ ok: true; app: string; title: string; x: number; y: number }>(`${sessionBase(target)}/window/click`, point),
  typeBoundWindow: (target: SessionTarget, input: { text: string; elementId?: string }) =>
    sendJson<{ ok: true; app: string; title: string; elementId: string }>(`${sessionBase(target)}/window/type`, input),
  readBoundWindow: (target: SessionTarget, elementId?: string) =>
    sendJson<{ ok: true; app: string; title: string; elementId: string; text: string }>(`${sessionBase(target)}/window/read`, elementId ? { elementId } : {}),
  keyBoundWindow: (target: SessionTarget, key: string) =>
    sendJson<{ ok: true; app: string; title: string; key: string }>(`${sessionBase(target)}/window/key`, { key }),
  scrollBoundWindow: (target: SessionTarget, input: { x: number; y: number; dx?: number; dy?: number }) =>
    sendJson<{ ok: true; app: string; title: string; x: number; y: number; dx?: number; dy?: number }>(`${sessionBase(target)}/window/scroll`, input),
  dragBoundWindow: (target: SessionTarget, input: { x: number; y: number; x2: number; y2: number }) =>
    sendJson<{ ok: true; app: string; title: string; x: number; y: number; x2: number; y2: number }>(`${sessionBase(target)}/window/drag`, input),
  listBoundWindowMenus: (target: SessionTarget) =>
    getJson<{ ok: true; app: string; title: string; menus: Array<{ path: string[] }> }>(`${sessionBase(target)}/window/menus`),
  menuBoundWindow: (target: SessionTarget, path: string[]) =>
    sendJson<{ ok: true; app: string; title: string; path: string[] }>(`${sessionBase(target)}/window/menu`, { path }),
  forget: (target: SessionTarget) => sendJson(`${sessionBase(target)}/forget`, {}),
  haltBusyLocal: () => sendJson<{ ids: string[]; count: number }>('/api/leophone/local/halt', {}),
  searchLocalTalk: (query: string) =>
    sendJson<{ query: string; hits: Array<{ session_id: string; text: string }>; truncated: boolean }>('/api/leophone/local/talk', { query }),
  continueLocal: (target: SessionTarget) =>
    sendJson<{ ok: true; session_id: string; session: SessionSummary }>(`${sessionBase(target)}/continue`, {}),
  approve: (target: SessionTarget, approvalId: string | null, choice: string) =>
    target.machine === 'local'
      ? sendJson(`${sessionBase(target)}/approval`, { approval_id: approvalId, choice })
      : sendJson('/api/leophone/approvals/respond', { machine: target.machine, session_id: target.id, approval_id: approvalId, choice }),
  setPolicy: (target: SessionTarget, policy: string) => sendJson(`${sessionBase(target)}/policy`, { policy }),
  renameLocalSession: (target: SessionTarget, title: string) =>
    sendJson<{ ok: true; title: string }>(`${sessionBase(target)}/title`, { title }),
  rpc: (target: SessionTarget, frame: Record<string, unknown>) => sendJson(`${sessionBase(target)}/rpc`, frame),

  /**
   * 订阅一条会话的事件流:先按 after 回放,再实时跟随。返回取消函数。
   * 用 fetch + reader 而不是 EventSource:后者带不上本地鉴权头。
   */
  subscribe(target: SessionTarget, after: number, onEvent: (event: HarnessEvent) => void, onClose?: (error?: Error) => void, onOpen?: () => void): () => void {
    const controller = new AbortController();
    (async () => {
      try {
        const response = await authenticatedFetch(`${sessionBase(target)}/events?after=${after}`, {
          headers: { Accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error(await readError(response));
        onOpen?.();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index: number;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data:')) continue;
              try {
                onEvent(JSON.parse(line.slice(5).trim()) as HarnessEvent);
              } catch {
                // 坏帧跳过,流继续。
              }
            }
          }
        }
        onClose?.();
      } catch (error) {
        if (controller.signal.aborted) return;
        onClose?.(error instanceof Error ? error : new Error(String(error)));
      }
    })();
    return () => controller.abort();
  },
};
