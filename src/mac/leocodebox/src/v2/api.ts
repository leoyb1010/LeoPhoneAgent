import { authenticatedFetch } from '../utils/apiClient';

// 2.0 渲染层与服务端的全部往来。本机会话走 /api/leophone/local/*(直连 HarnessManager),
// 远程机器走 /api/leophone/fleet/*(中继代理)。两条路吐同一种事件词汇。

export type SessionTarget = { machine: 'local' | string; id: string };

export type LastEvent = { event: string; text: string; timestamp: number } | null;

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
  configured: boolean;
  usingOAuth: boolean;
  usingSubscription: boolean;
  status: unknown;
  models: Array<{ id: string; name: string }>;
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

  createLocalSession: (input: { cwd: string; prompt: string; model?: string | null; policy?: string; harness?: string }) =>
    sendJson<{ session_id: string; session: SessionSummary }>('/api/leophone/local/sessions', { harness: 'pi', ...input }),
  createRemoteSession: (input: { machine: string; prompt: string; cwd?: string; harness?: string; model?: string | null; policy?: string }) =>
    sendJson<{ session_id: string }>('/api/leophone/fleet/sessions', { harness: 'pi', ...input }),

  summary: (target: SessionTarget) => getJson<SessionSummary>(sessionBase(target)),
  send: (target: SessionTarget, text: string) => sendJson(`${sessionBase(target)}/send`, { text }),
  stop: (target: SessionTarget) => sendJson(`${sessionBase(target)}/stop`, {}),
  approve: (target: SessionTarget, approvalId: string | null, choice: string) =>
    target.machine === 'local'
      ? sendJson(`${sessionBase(target)}/approval`, { approval_id: approvalId, choice })
      : sendJson('/api/leophone/approvals/respond', { machine: target.machine, session_id: target.id, approval_id: approvalId, choice }),
  setPolicy: (target: SessionTarget, policy: string) => sendJson(`${sessionBase(target)}/policy`, { policy }),
  rpc: (target: SessionTarget, frame: Record<string, unknown>) => sendJson(`${sessionBase(target)}/rpc`, frame),

  /**
   * 订阅一条会话的事件流:先按 after 回放,再实时跟随。返回取消函数。
   * 用 fetch + reader 而不是 EventSource:后者带不上本地鉴权头。
   */
  subscribe(target: SessionTarget, after: number, onEvent: (event: HarnessEvent) => void, onClose?: (error?: Error) => void): () => void {
    const controller = new AbortController();
    (async () => {
      try {
        const response = await authenticatedFetch(`${sessionBase(target)}/events?after=${after}`, {
          headers: { Accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error(await readError(response));
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
