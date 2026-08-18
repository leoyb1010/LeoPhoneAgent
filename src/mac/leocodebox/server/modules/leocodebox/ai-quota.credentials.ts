import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

/**
 * [T-quota-bar] 各家 CLI 落在本机的凭据读取。**只读,不写,不刷新。**
 *
 * 两条纪律:
 *  1. token 只在返回值里流转,**绝不**进日志、进错误消息、进快照。
 *     调用方拿到的错误里只有状态码和人话说明。
 *  2. 过期的凭据源要**跳过换下一个**,而不是拿去撞 401。
 *     本机实测:`~/.claude/.credentials.json` 里的 token 已过期十几天,
 *     而 Keychain 里的是新的 —— 顺序搞反就等于这家永远读不到额度。
 */

const execFileAsync = promisify(execFile);

/** 路径每次现算:测试会改 os.homedir(),模块加载时定死就跟着测试一起错。 */
const homeDir = (): string => os.homedir();

export const codexHome = (): string => process.env.CODEX_HOME || path.join(homeDir(), '.codex');
export const claudeCredentialsFile = (): string => path.join(homeDir(), '.claude', '.credentials.json');
export const geminiSettingsFile = (): string => path.join(homeDir(), '.gemini', 'settings.json');
export const geminiCredentialsFile = (): string => path.join(homeDir(), '.gemini', 'oauth_creds.json');

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    // 不存在 / 不是 JSON / 没权限,对调用方都是同一件事:这个源用不了。
    return null;
  }
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/* ------------------------------------------------------------------ Codex */

export type CodexCredential = { accessToken: string; accountId: string | null };

/** `$CODEX_HOME/auth.json` → `tokens.access_token`。 */
export async function readCodexCredential(): Promise<CodexCredential | null> {
  const auth = await readJson<{ tokens?: { access_token?: unknown; account_id?: unknown } }>(
    path.join(codexHome(), 'auth.json'),
  );
  const token = auth?.tokens?.access_token;
  if (!nonEmpty(token)) return null;
  return { accessToken: token, accountId: nonEmpty(auth?.tokens?.account_id) ? auth.tokens.account_id : null };
}

/* ----------------------------------------------------------------- Claude */

export type ClaudeCredential = {
  accessToken: string;
  expiresAt: number | null;
  subscriptionType: string | null;
  rateLimitTier: string | null;
  /** 这份凭据是从哪读到的,只用于 note/details,不含任何密钥内容。 */
  origin: 'keychain' | 'file';
};

export type ClaudeCredentialLookup = {
  credential: ClaudeCredential | null;
  /** 找到了但已过期的源。用来把"没登录"和"登录过但过期了"分开说。 */
  expiredOrigins: ClaudeCredential['origin'][];
};

type ClaudeOAuthBlob = {
  accessToken?: unknown;
  expiresAt?: unknown;
  subscriptionType?: unknown;
  rateLimitTier?: unknown;
};

/** 两种落盘形状都见过:带 claudeAiOauth 外层的,和直接就是那个对象的。 */
function parseClaudeBlob(raw: unknown, origin: ClaudeCredential['origin']): ClaudeCredential | null {
  if (!raw || typeof raw !== 'object') return null;
  const outer = raw as { claudeAiOauth?: ClaudeOAuthBlob } & ClaudeOAuthBlob;
  const blob = outer.claudeAiOauth ?? outer;
  if (!nonEmpty(blob.accessToken)) return null;
  return {
    accessToken: blob.accessToken,
    expiresAt: typeof blob.expiresAt === 'number' ? blob.expiresAt : null,
    subscriptionType: nonEmpty(blob.subscriptionType) ? blob.subscriptionType : null,
    rateLimitTier: nonEmpty(blob.rateLimitTier) ? blob.rateLimitTier : null,
    origin,
  };
}

/** 返回钥匙串里那条记录的原始 JSON 文本;没有就 null。测试会替换它。 */
export type KeychainReader = () => Promise<string | null>;

export const readClaudeKeychainRaw: KeychainReader = async () => {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await execFileAsync(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { timeout: 5_000, maxBuffer: 1024 * 1024 },
    );
    return stdout;
  } catch {
    // 没有这条钥匙串项 / 用户拒绝授权 —— 都退回文件。
    return null;
  }
};

async function readClaudeKeychain(reader: KeychainReader): Promise<ClaudeCredential | null> {
  const raw = await reader();
  if (!raw) return null;
  try {
    return parseClaudeBlob(JSON.parse(raw), 'keychain');
  } catch {
    return null;
  }
}

/**
 * Keychain 优先,文件兜底 —— 顺序照上游 CodexBar,而且这个顺序**很要紧**:
 * 本机实测 `~/.claude/.credentials.json` 里的 token 已经过期十几天,
 * 钥匙串里的才是新的。顺序反过来就等于这家永远 401。
 * 每个源都要先验 `expiresAt`,过期的直接跳过,别拿去换一个 401。
 */
export async function readClaudeCredential(
  nowMs: number = Date.now(),
  keychainReader: KeychainReader = readClaudeKeychainRaw,
): Promise<ClaudeCredentialLookup> {
  const expiredOrigins: ClaudeCredential['origin'][] = [];
  const candidates = [
    await readClaudeKeychain(keychainReader),
    parseClaudeBlob(await readJson<unknown>(claudeCredentialsFile()), 'file'),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate.expiresAt !== null && candidate.expiresAt <= nowMs) {
      expiredOrigins.push(candidate.origin);
      continue;
    }
    return { credential: candidate, expiredOrigins };
  }
  return { credential: null, expiredOrigins };
}

/* ----------------------------------------------------------------- Gemini */

export type GeminiCredential = {
  accessToken: string;
  refreshToken: string | null;
  expiryDate: number | null;
  expired: boolean;
};

/**
 * authType 在不同版本的 gemini-cli 里位置不一样(顶层 `selectedAuthType`、
 * 新版嵌在 `security.auth.selectedType`),所以递归找而不是写死路径。
 */
export function findGeminiAuthType(settings: unknown, depth = 0): string | null {
  if (depth > 6 || !settings || typeof settings !== 'object') return null;
  for (const [key, value] of Object.entries(settings as Record<string, unknown>)) {
    if ((key === 'authType' || key === 'selectedAuthType' || key === 'selectedType') && nonEmpty(value)) return value;
  }
  for (const value of Object.values(settings as Record<string, unknown>)) {
    const found = findGeminiAuthType(value, depth + 1);
    if (found) return found;
  }
  return null;
}

export async function readGeminiAuthType(): Promise<string | null> {
  return findGeminiAuthType(await readJson<unknown>(geminiSettingsFile()));
}

export async function readGeminiCredential(nowMs: number = Date.now()): Promise<GeminiCredential | null> {
  const raw = await readJson<{ access_token?: unknown; refresh_token?: unknown; expiry_date?: unknown }>(
    geminiCredentialsFile(),
  );
  if (!raw || !nonEmpty(raw.access_token)) return null;
  const expiryDate = typeof raw.expiry_date === 'number' ? raw.expiry_date : null;
  return {
    accessToken: raw.access_token,
    refreshToken: nonEmpty(raw.refresh_token) ? raw.refresh_token : null,
    expiryDate,
    expired: expiryDate !== null && expiryDate <= nowMs,
  };
}
