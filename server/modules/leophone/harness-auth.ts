import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type express from 'express';

import { LEOAGENT_HOME } from './harness-session.service.js';

// LeoPhoneAgent harness 面的鉴权——与 leoagent(Python)完全同构:
// 单一 Bearer key(≥16 字符),常数时间比对,除 /health 外全部端点必需。
// 钥匙与本机 UI 的 local token 完全隔离:手机的钥匙进不了 /api,
// UI 的 token 也开不了 harness。

const KEY_PATH = path.join(LEOAGENT_HOME, 'key');

let cachedKey: string | null = null;
let cachedMtimeMs = -1;

/** 剥掉复制残渣:终端复制常带 zsh 行尾标记 % 或换行,密钥本身不含这些。 */
function cleanKey(raw: string): string {
  return raw.trim().replace(/%+$/, '').trim();
}

/**
 * 手机侧钥匙:LEOAGENT_KEY 环境变量优先(与 leoagent 同名同义),否则读
 * ~/.leoagent/key。不足 16 字符按未配置处理——宽松的默认值会把这台 Mac 上
 * 的每个编码 Agent 暴露给任何能碰到端口的人。
 */
export function loadHarnessKey(): string | null {
  const fromEnv = cleanKey(process.env.LEOAGENT_KEY || '');
  if (fromEnv.length >= 16) return fromEnv;
  try {
    const stat = fs.statSync(KEY_PATH);
    if (cachedKey !== null && stat.mtimeMs === cachedMtimeMs) return cachedKey;
    const key = cleanKey(fs.readFileSync(KEY_PATH, 'utf8'));
    cachedKey = key.length >= 16 ? key : null;
    cachedMtimeMs = stat.mtimeMs;
    return cachedKey;
  } catch {
    cachedKey = null;
    cachedMtimeMs = -1;
    return null;
  }
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // 仍做一次比较,消除长度导致的早退时序差异。
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function unauthorizedBody(): Record<string, unknown> {
  return { error: { message: 'Invalid gateway key', code: 'leoagent_auth_failed' } };
}

/** Bearer 校验中间件。未配置钥匙 → 503(手机拿到可行动的错误而不是 401)。 */
export function requireHarnessKey(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const key = loadHarnessKey();
  if (!key) {
    res.status(503).json({ error: {
      message: 'LeoPhone harness is not configured on this Mac: put a 16+ char key in ~/.leoagent/key',
      code: 'leoagent_key_missing',
    } });
    return;
  }
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) {
    res.status(401).json(unauthorizedBody());
    return;
  }
  const presented = cleanKey(header.slice(7));
  if (!timingSafeEqualStr(presented, key)) {
    res.status(401).json(unauthorizedBody());
    return;
  }
  next();
}
