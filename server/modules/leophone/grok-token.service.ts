import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// [T-grok-via-mac] 手机不自己跑 xAI OAuth(回环端口回调在 iOS 上易碎),
// 向这台 Mac 借 grok CLI 的登录:返回当前有效 access token,快过期就用
// refresh_token 刷新并原子写回 auth.json。
//
// 与 Python 版的一处差异:Python 用 fcntl.flock(auth.json.lock) 与 CLI 的
// 刷新互斥;Node 无内建 flock,这里用 O_EXCL 侧车锁 + 陈旧锁超时近似。
// 碰撞窗口只在"手机与 CLI 同秒刷新"时存在,失败表现为需要重新 grok login。

const AUTH_PATH = path.join(os.homedir(), '.grok', 'auth.json');
const LOCK_PATH = `${AUTH_PATH}.leophone-lock`;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 100;
const LOCK_RETRIES = 50;

export interface GrokTokenResult {
  status: number;
  body: Record<string, unknown>;
}

function errorResult(status: number, message: string): GrokTokenResult {
  return { status, body: { error: { message } } };
}

async function acquireLock(): Promise<(() => void) | null> {
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    try {
      const fd = fs.openSync(LOCK_PATH, 'wx');
      fs.closeSync(fd);
      return () => {
        try {
          fs.unlinkSync(LOCK_PATH);
        } catch {
          // best effort
        }
      };
    } catch {
      try {
        const stat = fs.statSync(LOCK_PATH);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(LOCK_PATH);
          continue;
        }
      } catch {
        continue; // 锁刚被释放,重试
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
  return null;
}

export async function fetchGrokToken(): Promise<GrokTokenResult> {
  if (!fs.existsSync(AUTH_PATH)) {
    return errorResult(502, '这台 Mac 上的 grok 未登录:在 Mac 终端运行 grok login');
  }
  const release = await acquireLock();
  if (!release) {
    return errorResult(502, 'grok 登录文件正被占用,稍后重试');
  }
  try {
    const data = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8')) as Record<string, unknown>;
    let entryKey: string | null = null;
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const candidate = value as Record<string, unknown>;
        if (candidate.key && candidate.refresh_token) {
          entryKey = key;
          break;
        }
      }
    }
    if (entryKey === null) {
      return errorResult(502, 'grok 登录记录不完整:在 Mac 终端重新 grok login');
    }
    const entry = data[entryKey] as Record<string, unknown>;
    let expiresAt = new Date(String(entry.expires_at || ''));
    if (Number.isNaN(expiresAt.getTime())) expiresAt = new Date();

    if (expiresAt.getTime() - Date.now() < 10 * 60 * 1000) {
      const issuer = String(entry.oidc_issuer || 'https://auth.x.ai');
      const wellKnown = await fetch(`${issuer}/.well-known/openid-configuration`, {
        signal: AbortSignal.timeout(15_000),
      });
      const tokenEndpoint = String(((await wellKnown.json()) as Record<string, unknown>).token_endpoint || '');
      const refreshed = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: String(entry.refresh_token),
          client_id: String(entry.oidc_client_id || ''),
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!refreshed.ok) {
        const detail = (await refreshed.text()).slice(0, 200);
        return errorResult(502, `grok 登录刷新被拒(${refreshed.status}):在 Mac 终端重新 grok login。${detail}`);
      }
      const tok = (await refreshed.json()) as Record<string, unknown>;
      entry.key = tok.access_token;
      if (tok.refresh_token) entry.refresh_token = tok.refresh_token;
      const newExp = new Date(Date.now() + Number(tok.expires_in || 3600) * 1000);
      entry.expires_at = newExp.toISOString().replace(/\.\d{3}Z$/, 'Z');
      const tmp = `${AUTH_PATH}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, AUTH_PATH);
      expiresAt = newExp;
    }
    return {
      status: 200,
      body: {
        access_token: entry.key,
        expires_at: expiresAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        email: entry.email || '',
      },
    };
  } catch (error) {
    return errorResult(502, `grok token 获取失败: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    release();
  }
}
