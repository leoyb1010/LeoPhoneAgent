import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import WebSocket from 'ws';

import { loadHarnessKey } from './harness-auth.js';
import { LEOAGENT_HOME } from './harness-session.service.js';

// 中继客户端——leoagent(Python relay_client.py)的 TS 移植:出站 WebSocket
// 挂上自营 relay,手机从任何网络找到这台 Mac。协议帧与 relay.py 对偶:
// register / http / resp / stream_open / stream_data / stream_close / stream_cancel。
//
// 灰度机制(相对原版新增):relay 按机器名同名顶替。若本机的 leoagent
// (Python, :8646)还活着,说明它仍在注册——本客户端进入待命轮询,避免两个
// 进程互相顶替造成手机侧连接抖动;leoagent 一停,60 秒内自动接管。
// LEOPHONE_RELAY_TAKEOVER=1 跳过待命立即接管;LEOPHONE_RELAY=0 整体停用。

const RELAY_CONFIG_PATH = path.join(LEOAGENT_HOME, 'relay.json');
const LEGACY_LEOAGENT_HEALTH = 'http://127.0.0.1:8646/health';
const STANDBY_POLL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 55_000;
const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 75_000;

interface RelayConfig {
  wsUrl: string;
  relayKey: string;
  localKey: string;
  name: string;
}

function log(message: string): void {
  console.log(`[leophone-relay] ${message}`);
}

/** relay 地址与钥匙:环境变量优先,其次 ~/.leoagent/relay.json(与 leoagent 共用)。 */
function resolveConfig(): RelayConfig | null {
  let url = (process.env.LEOAGENT_RELAY_URL || '').trim();
  let relayKey = (process.env.LEOAGENT_RELAY_KEY || '').trim();
  if (!url) {
    try {
      const parsed = JSON.parse(fs.readFileSync(RELAY_CONFIG_PATH, 'utf8')) as { url?: string; key?: string };
      url = String(parsed.url || '').trim();
      if (!relayKey) relayKey = String(parsed.key || '').trim();
    } catch {
      return null;
    }
  }
  if (!url) return null;
  const localKey = loadHarnessKey();
  if (!localKey) return null;
  if (!relayKey) relayKey = localKey;

  let wsUrl = url.replace(/\/+$/, '');
  if (!wsUrl.endsWith('/relay/agent')) wsUrl = `${wsUrl}/relay/agent`;
  wsUrl = wsUrl.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');

  const name = (process.env.LEOAGENT_RELAY_NAME || '').trim() || os.hostname().split('.')[0];
  return { wsUrl, relayKey, localKey, name };
}

/** leoagent(Python)是否仍在本机服役——在,则它也在向 relay 注册。 */
async function legacyLeoagentAlive(): Promise<boolean> {
  try {
    const res = await fetch(LEGACY_LEOAGENT_HEALTH, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

export class LeophoneRelayClient {
  private readonly streamAborts = new Map<string, AbortController>();
  private stopped = false;

  constructor(private readonly config: RelayConfig, private readonly localPort: number) {}

  private localUrl(tail: string): string {
    // 中继透传的是 leoagent 本体的根路径(/harness/*、/v1/*);本机落到
    // leophone 模块的前缀挂载上。
    return `http://127.0.0.1:${this.localPort}/leophone${tail}`;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.config.localKey}` };
  }

  async runForever(): Promise<void> {
    let backoff = 1;
    while (!this.stopped) {
      // 待命:leoagent 还在注册就不去顶它,防止同名互踢造成手机侧抖动。
      if (process.env.LEOPHONE_RELAY_TAKEOVER !== '1' && await legacyLeoagentAlive()) {
        log(`standby: legacy leoagent is still serving :8646 on this Mac; will take over "${this.config.name}" once it stops`);
        await new Promise((resolve) => setTimeout(resolve, STANDBY_POLL_MS));
        continue;
      }
      try {
        await this.runOnce();
        backoff = 1;
      } catch (error) {
        log(`disconnected: ${error instanceof Error ? error.message : String(error)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, backoff * 1000));
      backoff = Math.min(backoff * 2, 30);
    }
  }

  /** 单次连接周期;runForever 负责退避重连。导出供测试直接驱动。 */
  runOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.config.wsUrl, { handshakeTimeout: 15_000 });
      let lastPong = Date.now();
      let pingTimer: NodeJS.Timeout | null = null;
      let settled = false;

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (pingTimer) clearInterval(pingTimer);
        for (const controller of this.streamAborts.values()) controller.abort();
        this.streamAborts.clear();
        try {
          ws.terminate();
        } catch {
          // already closed
        }
        if (error) reject(error);
        else resolve();
      };

      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'register',
          name: this.config.name,
          key: this.config.relayKey,
          info: { platform: 'leoagent', server: 'leocodebox' },
        }));
        log(`connected to relay as ${this.config.name}`);
        lastPong = Date.now();
        pingTimer = setInterval(() => {
          if (Date.now() - lastPong > PONG_TIMEOUT_MS) {
            finish(new Error('relay heartbeat lost'));
            return;
          }
          try {
            ws.ping();
          } catch {
            // socket already closing
          }
        }, PING_INTERVAL_MS);
      });
      ws.on('pong', () => { lastPong = Date.now(); });
      // relay 侧(aiohttp heartbeat)也会主动 ping;ws 库自动回 pong,
      // 这里顺带刷新活性。
      ws.on('ping', () => { lastPong = Date.now(); });

      ws.on('message', (data) => {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(String(data)) as Record<string, unknown>;
        } catch {
          return;
        }
        const kind = frame.type;
        if (kind === 'http') {
          void this.handleHttp(ws, frame);
        } else if (kind === 'stream_open') {
          void this.handleStream(ws, frame);
        } else if (kind === 'stream_cancel') {
          this.streamAborts.get(String(frame.id))?.abort();
        }
      });

      ws.on('close', (code, reason) => {
        finish(new Error(`relay closed (${code}${reason?.length ? ` ${reason.toString()}` : ''})`));
      });
      ws.on('error', (error) => finish(error instanceof Error ? error : new Error(String(error))));
    });
  }

  private send(ws: WebSocket, frame: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame));
    }
  }

  private async handleHttp(ws: WebSocket, frame: Record<string, unknown>): Promise<void> {
    const requestId = frame.id;
    const method = String(frame.method || 'GET').toUpperCase();
    const tail = String(frame.path || '/');
    const body = frame.body;
    try {
      const res = await fetch(this.localUrl(tail), {
        method,
        headers: body != null
          ? { ...this.headers(), 'Content-Type': 'application/json' }
          : this.headers(),
        body: body != null ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      let payload: unknown;
      const text = await res.text();
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text };
      }
      this.send(ws, { type: 'resp', id: requestId, status: res.status, body: payload });
    } catch (error) {
      this.send(ws, {
        type: 'resp', id: requestId, status: 502,
        body: { error: { message: `local call failed: ${error instanceof Error ? error.message : String(error)}` } },
      });
    }
  }

  private async handleStream(ws: WebSocket, frame: Record<string, unknown>): Promise<void> {
    const streamId = String(frame.id);
    const tail = String(frame.path || '/');
    const controller = new AbortController();
    this.streamAborts.set(streamId, controller);
    try {
      const res = await fetch(this.localUrl(tail), {
        headers: { ...this.headers(), Accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (!res.body) throw new Error(`no body (${res.status})`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        let newline = buffered.indexOf('\n');
        while (newline !== -1) {
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          // 本机是 SSE 帧("data: {...}"),剥前缀转纯数据帧;注释保活跳过。
          if (line.startsWith('data: ')) {
            this.send(ws, { type: 'stream_data', id: streamId, data: line.slice(6) });
          }
          newline = buffered.indexOf('\n');
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        log(`stream ${streamId} error: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      this.streamAborts.delete(streamId);
      this.send(ws, { type: 'stream_close', id: streamId });
    }
  }
}

let started = false;

/**
 * 常驻本进程事件循环。失败只影响 relay 通路,不影响本机服务。
 * 未配置 relay(无 relay.json 且无环境变量)则安静跳过。
 */
export function startLeophoneRelayClient(): void {
  if (started) return;
  started = true;
  if ((process.env.LEOPHONE_RELAY || '').trim() === '0') {
    log('disabled via LEOPHONE_RELAY=0');
    return;
  }
  const config = resolveConfig();
  if (!config) {
    log('not configured (no ~/.leoagent/relay.json and no LEOAGENT_RELAY_URL); skipping');
    return;
  }
  const localPort = Number.parseInt(process.env.SERVER_PORT || '', 10) || 3001;
  const client = new LeophoneRelayClient(config, localPort);
  void client.runForever();
}
