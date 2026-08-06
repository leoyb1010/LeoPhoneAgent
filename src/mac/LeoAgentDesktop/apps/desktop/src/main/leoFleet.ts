/**
 * leoFleet — Mac 舰队状态 IPC(LeoAgent 分叉新增)。
 *
 * 读 ~/.leoagent/relay.json({url, key},装机脚本写入),向自营中继拉取
 * 机器列表与每台的活跃会话数。密钥只在 main 进程,renderer 拿到的是纯状态。
 * 任何失败都回 {ok:false, error} —— 舰队面板降级显示,不影响其他功能。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ipcMain, net } from 'electron';

interface RelayConfig {
  url: string;
  key: string;
}

function readRelayConfig(): RelayConfig | null {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.leoagent', 'relay.json'), 'utf8');
    const parsed = JSON.parse(raw) as Partial<RelayConfig>;
    if (typeof parsed.url === 'string' && typeof parsed.key === 'string') {
      return { url: parsed.url.replace(/\/$/, ''), key: parsed.key };
    }
  } catch {
    /* 未配置即降级 */
  }
  return null;
}

function fetchJson(url: string, key: string, timeoutMs = 8000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = net.request(url);
    request.setHeader('Authorization', `Bearer ${key}`);
    const timer = setTimeout(() => {
      request.abort();
      reject(new Error('timeout'));
    }, timeoutMs);
    request.on('response', (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (err) {
          reject(err);
        }
      });
    });
    request.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    request.end();
  });
}

export function registerLeoFleetIpc(): void {
  ipcMain.handle('leo:fleet-status', async () => {
    const config = readRelayConfig();
    if (!config) {
      return { ok: false, error: '未配置 relay.json', machines: [] };
    }
    try {
      const data = (await fetchJson(`${config.url}/relay/api/machines`, config.key)) as {
        machines?: Array<{ name?: string }>;
      };
      const machines = await Promise.all(
        (data.machines ?? []).map(async (machine) => {
          const name = String(machine.name ?? 'mac');
          let sessions: number | undefined;
          let version: string | undefined;
          try {
            const detail = (await fetchJson(
              `${config.url}/relay/api/m/${encodeURIComponent(name)}/harness/sessions`,
              config.key,
              6000,
            )) as { sessions?: Array<{ status?: string }> };
            sessions = (detail.sessions ?? []).filter(
              (s) => s.status && !['orphaned', 'completed', 'failed', 'cancelled'].includes(s.status),
            ).length;
          } catch {
            /* 单机失败不拖垮列表 */
          }
          try {
            const health = (await fetchJson(
              `${config.url}/relay/api/m/${encodeURIComponent(name)}/health`,
              config.key,
              5000,
            )) as { version?: string };
            version = health.version;
          } catch {
            /* 同上 */
          }
          return { name, online: true, sessions, version };
        }),
      );
      return { ok: true, relayUrl: config.url, machines };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), machines: [] };
    }
  });
}
